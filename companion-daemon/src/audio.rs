use std::fs::File;
use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioLevels {
    pub mic_db: f32,
    pub system_db: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingStatus {
    pub is_recording: bool,
    pub is_paused: bool,
    pub elapsed_seconds: f64,
    pub file_path: Option<String>,
    pub levels: AudioLevels,
}

pub struct AudioRecorder {
    is_recording: Arc<AtomicBool>,
    is_paused: Arc<AtomicBool>,
    start_time: Arc<Mutex<Option<Instant>>>,
    current_levels: Arc<Mutex<AudioLevels>>,
    current_path: Arc<Mutex<Option<PathBuf>>>,
    stop_signal: Arc<AtomicBool>,
    join_handle: Option<std::thread::JoinHandle<()>>,
}

impl AudioRecorder {
    pub fn new() -> Self {
        Self {
            is_recording: Arc::new(AtomicBool::new(false)),
            is_paused: Arc::new(AtomicBool::new(false)),
            start_time: Arc::new(Mutex::new(None)),
            current_levels: Arc::new(Mutex::new(AudioLevels {
                mic_db: -60.0,
                system_db: -60.0,
            })),
            current_path: Arc::new(Mutex::new(None)),
            stop_signal: Arc::new(AtomicBool::new(false)),
            join_handle: None,
        }
    }

    pub fn start(&mut self, output_path: PathBuf) -> Result<(), String> {
        if self.is_recording.load(Ordering::SeqCst) {
            return Err("Already recording".to_string());
        }

        if let Some(parent) = output_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        self.stop_signal.store(false, Ordering::SeqCst);
        self.is_paused.store(false, Ordering::SeqCst);
        self.is_recording.store(true, Ordering::SeqCst);
        *self.start_time.lock() = Some(Instant::now());
        *self.current_path.lock() = Some(output_path.clone());

        let is_recording = self.is_recording.clone();
        let is_paused = self.is_paused.clone();
        let stop_signal = self.stop_signal.clone();
        let levels = self.current_levels.clone();
        let file_path = output_path;

        let handle = std::thread::spawn(move || {
            if let Err(e) = record_thread_loop(file_path, is_recording, is_paused, stop_signal, levels) {
                log::error!("Audio capture error: {}", e);
            }
        });

        self.join_handle = Some(handle);
        Ok(())
    }

    pub fn stop(&mut self) -> Option<PathBuf> {
        if !self.is_recording.load(Ordering::SeqCst) {
            return None;
        }

        self.stop_signal.store(true, Ordering::SeqCst);
        if let Some(handle) = self.join_handle.take() {
            let _ = handle.join();
        }

        self.is_recording.store(false, Ordering::SeqCst);
        self.is_paused.store(false, Ordering::SeqCst);
        *self.start_time.lock() = None;

        self.current_path.lock().take()
    }

    pub fn pause(&self) {
        if self.is_recording.load(Ordering::SeqCst) {
            self.is_paused.store(true, Ordering::SeqCst);
        }
    }

    pub fn resume(&self) {
        if self.is_recording.load(Ordering::SeqCst) {
            self.is_paused.store(false, Ordering::SeqCst);
        }
    }

    pub fn get_status(&self) -> RecordingStatus {
        let is_rec = self.is_recording.load(Ordering::SeqCst);
        let is_p = self.is_paused.load(Ordering::SeqCst);
        let elapsed = if let Some(start) = *self.start_time.lock() {
            start.elapsed().as_secs_f64()
        } else {
            0.0
        };

        RecordingStatus {
            is_recording: is_rec,
            is_paused: is_p,
            elapsed_seconds: elapsed,
            file_path: self.current_path.lock().as_ref().map(|p| p.to_string_lossy().to_string()),
            levels: self.current_levels.lock().clone(),
        }
    }
}

fn record_thread_loop(
    output_path: PathBuf,
    is_recording: Arc<AtomicBool>,
    is_paused: Arc<AtomicBool>,
    stop_signal: Arc<AtomicBool>,
    levels: Arc<Mutex<AudioLevels>>,
) -> Result<(), String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }

    let spec = hound::WavSpec {
        channels: 2,
        sample_rate: 16000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let file = File::create(&output_path).map_err(|e| format!("Create WAV failed: {}", e))?;
    let mut writer = hound::WavWriter::new(BufWriter::new(file), spec)
        .map_err(|e| format!("WavWriter init failed: {}", e))?;

    // Safe initialization of WASAPI captures
    let loopback = WasapiCaptureSession::new(true);
    let mic = WasapiCaptureSession::new(false);

    let mut mic_session = match mic {
        Ok(s) => Some(s),
        Err(e) => {
            log::warn!("Microphone WASAPI not initialized: {}", e);
            None
        }
    };

    let mut sys_session = match loopback {
        Ok(s) => Some(s),
        Err(e) => {
            log::warn!("System Loopback WASAPI not initialized: {}", e);
            None
        }
    };

    log::info!("Audio capture loop started -> {:?}", output_path);

    let loop_start = Instant::now();
    let mut total_written_frames: u64 = 0;
    let mut last_meter_update = Instant::now();
    let mut mic_sum_sq = 0.0f32;
    let mut mic_samples_count = 0usize;
    let mut sys_sum_sq = 0.0f32;
    let mut sys_samples_count = 0usize;

    while !stop_signal.load(Ordering::SeqCst) {
        if is_paused.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(50));
            continue;
        }

        // Read up to 20ms of audio
        let mut mic_frames: Vec<f32> = Vec::new();
        let mut sys_frames: Vec<f32> = Vec::new();

        if let Some(ref mut s) = mic_session {
            if let Ok(samples) = s.read_samples() {
                mic_frames = samples;
            }
        }

        if let Some(ref mut s) = sys_session {
            if let Ok(samples) = s.read_samples() {
                sys_frames = samples;
            }
        }

        let max_len = mic_frames.len().max(sys_frames.len());

        if max_len > 0 {
            for i in 0..max_len {
                let m_val = if i < mic_frames.len() { mic_frames[i] } else { 0.0 };
                let s_val = if i < sys_frames.len() { sys_frames[i] } else { 0.0 };

                mic_sum_sq += m_val * m_val;
                mic_samples_count += 1;

                sys_sum_sq += s_val * s_val;
                sys_samples_count += 1;

                let m_i16 = (m_val.clamp(-1.0, 1.0) * 32767.0) as i16;
                let s_i16 = (s_val.clamp(-1.0, 1.0) * 32767.0) as i16;

                // Channel 0 = Mic (You), Channel 1 = System (Remote)
                let _ = writer.write_sample(m_i16);
                let _ = writer.write_sample(s_i16);
            }
            total_written_frames += max_len as u64;
        } else {
            // Keep audio stream perfectly synchronized with wall-clock time
            let expected_frames = (loop_start.elapsed().as_secs_f64() * 16000.0) as u64;
            let frames_to_pad = expected_frames.saturating_sub(total_written_frames);
            for _ in 0..frames_to_pad {
                let _ = writer.write_sample(0i16);
                let _ = writer.write_sample(0i16);
            }
            total_written_frames += frames_to_pad;
        }

        // Update VU meters every 100ms
        if last_meter_update.elapsed() >= std::time::Duration::from_millis(100) {
            let m_rms = if mic_samples_count > 0 {
                (mic_sum_sq / mic_samples_count as f32).sqrt()
            } else {
                0.0
            };
            let s_rms = if sys_samples_count > 0 {
                (sys_sum_sq / sys_samples_count as f32).sqrt()
            } else {
                0.0
            };

            let m_db = 20.0 * (m_rms.max(1e-4)).log10();
            let s_db = 20.0 * (s_rms.max(1e-4)).log10();

            *levels.lock() = AudioLevels {
                mic_db: m_db.clamp(-60.0, 0.0),
                system_db: s_db.clamp(-60.0, 0.0),
            };

            mic_sum_sq = 0.0;
            mic_samples_count = 0;
            sys_sum_sq = 0.0;
            sys_samples_count = 0;
            last_meter_update = Instant::now();
        }

        std::thread::sleep(std::time::Duration::from_millis(15));
    }

    let _ = writer.flush();
    if let Err(e) = writer.finalize() {
        log::warn!("WavWriter finalize: {}", e);
    }
    is_recording.store(false, Ordering::SeqCst);
    log::info!("Audio capture loop finalized ({} frames) -> {:?}", total_written_frames, output_path);

    unsafe {
        CoUninitialize();
    }

    Ok(())
}

struct WasapiCaptureSession {
    client: IAudioClient,
    capture_client: IAudioCaptureClient,
    channels: u16,
    sample_rate: u32,
}

impl WasapiCaptureSession {
    pub fn new(is_loopback: bool) -> Result<Self, String> {
        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                    .map_err(|e| format!("CoCreateInstance MMDeviceEnumerator failed: {}", e))?;

            let device = if is_loopback {
                enumerator
                    .GetDefaultAudioEndpoint(eRender, eMultimedia)
                    .map_err(|e| format!("GetDefaultAudioEndpoint(eRender) failed: {}", e))?
            } else {
                enumerator
                    .GetDefaultAudioEndpoint(eCapture, eCommunications)
                    .or_else(|_| enumerator.GetDefaultAudioEndpoint(eCapture, eMultimedia))
                    .map_err(|e| format!("GetDefaultAudioEndpoint(eCapture) failed: {}", e))?
            };

            let client: IAudioClient = device
                .Activate(CLSCTX_ALL, None)
                .map_err(|e| format!("Activate IAudioClient failed: {}", e))?;

            let mix_format = client
                .GetMixFormat()
                .map_err(|e| format!("GetMixFormat failed: {}", e))?;

            let fmt = &*mix_format;
            let channels = fmt.nChannels;
            let sample_rate = fmt.nSamplesPerSec;

            let flags = if is_loopback {
                AUDCLNT_STREAMFLAGS_LOOPBACK
            } else {
                0
            };

            client
                .Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    flags,
                    10_000_000, // 1 second buffer
                    0,
                    mix_format,
                    None,
                )
                .map_err(|e| format!("IAudioClient::Initialize failed: {}", e))?;

            let capture_client: IAudioCaptureClient = client
                .GetService()
                .map_err(|e| format!("GetService IAudioCaptureClient failed: {}", e))?;

            client
                .Start()
                .map_err(|e| format!("IAudioClient::Start failed: {}", e))?;

            Ok(Self {
                client,
                capture_client,
                channels,
                sample_rate,
            })
        }
    }

    pub fn read_samples(&mut self) -> Result<Vec<f32>, String> {
        let mut out = Vec::new();
        unsafe {
            let mut packet_size = self
                .capture_client
                .GetNextPacketSize()
                .map_err(|e| format!("GetNextPacketSize failed: {}", e))?;

            while packet_size > 0 {
                let mut data_ptr = std::ptr::null_mut();
                let mut num_frames = 0u32;
                let mut flags = 0u32;

                self.capture_client
                    .GetBuffer(&mut data_ptr, &mut num_frames, &mut flags, None, None)
                    .map_err(|e| format!("GetBuffer failed: {}", e))?;

                if flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 {
                    // Silent buffer
                    let mono_frames = num_frames as usize;
                    out.extend(vec![0.0f32; mono_frames]);
                } else if !data_ptr.is_null() && num_frames > 0 {
                    // Standard IEEE float samples
                    let float_ptr = data_ptr as *const f32;
                    let channels = self.channels as usize;
                    let total_samples = num_frames as usize * channels;
                    let slice = std::slice::from_raw_parts(float_ptr, total_samples);

                    // Downmix interleaved channels to mono
                    for frame_idx in 0..(num_frames as usize) {
                        let mut sum = 0.0f32;
                        for ch in 0..channels {
                            sum += slice[frame_idx * channels + ch];
                        }
                        out.push(sum / channels as f32);
                    }
                }

                self.capture_client
                    .ReleaseBuffer(num_frames)
                    .map_err(|e| format!("ReleaseBuffer failed: {}", e))?;

                packet_size = self
                    .capture_client
                    .GetNextPacketSize()
                    .unwrap_or(0);
            }
        }

        // Resample from `self.sample_rate` to 16,000 Hz if necessary
        if self.sample_rate == 16000 || out.is_empty() {
            return Ok(out);
        }

        // Integer downsample by 3 for 48,000 Hz -> 16,000 Hz
        if self.sample_rate == 48000 {
            let mut resampled = Vec::with_capacity(out.len() / 3);
            for chunk in out.chunks_exact(3) {
                resampled.push((chunk[0] + chunk[1] + chunk[2]) / 3.0);
            }
            return Ok(resampled);
        }

        // General linear interpolation resampler
        let ratio = self.sample_rate as f64 / 16000.0;
        let target_len = (out.len() as f64 / ratio) as usize;
        let mut resampled = Vec::with_capacity(target_len);
        for i in 0..target_len {
            let src_idx = (i as f64 * ratio) as usize;
            if src_idx < out.len() {
                resampled.push(out[src_idx]);
            }
        }

        Ok(resampled)
    }
}

impl Drop for WasapiCaptureSession {
    fn drop(&mut self) {
        unsafe {
            let _ = self.client.Stop();
        }
    }
}
