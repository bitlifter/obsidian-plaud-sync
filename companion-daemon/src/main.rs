use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use clap::Parser;
use parking_lot::Mutex;
use tokio::sync::broadcast;

mod audio;
mod detector;
mod screenshot;
mod server;

use audio::AudioRecorder;
use detector::{scan_for_meetings, DetectedMeeting};
use server::{format_timecode, run_websocket_server, ServerContext, ServerEvent};

#[derive(Parser, Debug)]
#[command(author, version, about = "Standalone WASAPI Meeting Recorder Daemon", long_about = None)]
struct Args {
    #[arg(short, long, default_value_t = 8198)]
    port: u16,

    #[arg(short, long)]
    vault_dir: Option<PathBuf>,

    #[arg(long, default_value_t = true)]
    auto_record: bool,

    #[arg(long)]
    test_run: Option<u64>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let args = Args::parse();

    let vault_dir = args.vault_dir.unwrap_or_else(|| {
        let app_data = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
        PathBuf::from(app_data).join("meeting-recordings")
    });

    let _ = std::fs::create_dir_all(&vault_dir);
    log::info!("Meeting Recorder Daemon v{}", env!("CARGO_PKG_VERSION"));
    log::info!("Recordings & slides target: {:?}", vault_dir);
    log::info!("Auto-recording enabled: {}", args.auto_record);

    let (tx, _rx) = broadcast::channel(64);
    let recorder = Arc::new(Mutex::new(AudioRecorder::new()));
    let active_meeting = Arc::new(Mutex::new(None::<DetectedMeeting>));

    let server_ctx = Arc::new(ServerContext {
        recorder: recorder.clone(),
        active_meeting: active_meeting.clone(),
        vault_attachments_dir: vault_dir.clone(),
        tx: tx.clone(),
    });

    // Start WebSocket Server on background task
    let port = args.port;
    let srv_ctx_clone = server_ctx.clone();
    tokio::spawn(async move {
        if let Err(e) = run_websocket_server(port, srv_ctx_clone).await {
            log::error!("WebSocket server error: {}", e);
        }
    });

    // Test mode: record N seconds and exit
    if let Some(seconds) = args.test_run {
        log::info!("Running test recording for {} seconds...", seconds);
        let test_wav = vault_dir.join("test_recording.wav");
        recorder.lock().start(test_wav.clone()).expect("Start test record failed");

        for i in 1..=seconds {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let status = recorder.lock().get_status();
            log::info!(
                "Test recording... {}s / {}s (Mic: {:.1} dB, Sys: {:.1} dB)",
                i,
                seconds,
                status.levels.mic_db,
                status.levels.system_db
            );
        }

        let saved = recorder.lock().stop();
        log::info!("Test recording saved to: {:?}", saved);
        return Ok(());
    }

    // Main Meeting Detection & Polling Loop
    let mut last_seen_meeting: Option<Instant> = None;
    let grace_period = Duration::from_secs(15);
    let mut ticker = tokio::time::interval(Duration::from_millis(100));

    loop {
        ticker.tick().await;

        let detected = scan_for_meetings();
        let is_recording = recorder.lock().get_status().is_recording;

        if let Some(meeting) = detected {
            last_seen_meeting = Some(Instant::now());
            let prev_meeting = active_meeting.lock().clone();

            if prev_meeting.as_ref() != Some(&meeting) {
                log::info!("Meeting detected: {} - '{}'", meeting.app, meeting.title);
                let _ = tx.send(ServerEvent::MeetingDetected {
                    meeting: meeting.clone(),
                });
                *active_meeting.lock() = Some(meeting.clone());
            }

            if args.auto_record && !is_recording {
                let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
                let sanitized_title = meeting
                    .title
                    .replace(|c: char| !c.is_alphanumeric() && c != '_' && c != '-', "_");
                let filename = format!("{}_{}_{}.wav", timestamp, meeting.app.replace(' ', ""), sanitized_title);
                let path = vault_dir.join(&filename);

                log::info!("Auto-starting recording: {:?}", path);
                if recorder.lock().start(path.clone()).is_ok() {
                    let _ = tx.send(ServerEvent::RecordingStarted {
                        file_path: path.to_string_lossy().to_string(),
                        meeting: Some(meeting),
                    });
                }
            }
        } else {
            // Meeting is no longer detected
            if is_recording {
                if let Some(last_seen) = last_seen_meeting {
                    if last_seen.elapsed() >= grace_period {
                        log::info!("Grace period expired. Meeting ended. Finalizing recording...");
                        let status = recorder.lock().get_status();
                        let saved = recorder.lock().stop();
                        let meeting_info = active_meeting.lock().take();

                        if let Some(path) = saved {
                            let _ = tx.send(ServerEvent::RecordingStopped {
                                file_path: path.to_string_lossy().to_string(),
                                duration_seconds: status.elapsed_seconds,
                                meeting: meeting_info,
                            });
                        }
                        last_seen_meeting = None;
                    }
                }
            } else {
                *active_meeting.lock() = None;
            }
        }

        // Emit Tick Event with audio levels and timecode
        let status = recorder.lock().get_status();
        let current_meeting = active_meeting.lock().clone();
        let formatted = format_timecode(status.elapsed_seconds);

        let _ = tx.send(ServerEvent::Tick {
            is_recording: status.is_recording,
            is_paused: status.is_paused,
            elapsed_seconds: status.elapsed_seconds,
            timecode_formatted: formatted,
            active_meeting: current_meeting,
            levels: status.levels,
        });
    }
}
