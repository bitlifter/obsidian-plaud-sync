use std::net::SocketAddr;
use std::sync::Arc;
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::Message;

use crate::audio::{AudioLevels, AudioRecorder};
use crate::detector::DetectedMeeting;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ServerEvent {
    #[serde(rename = "tick")]
    Tick {
        is_recording: bool,
        is_paused: bool,
        elapsed_seconds: f64,
        timecode_formatted: String,
        active_meeting: Option<DetectedMeeting>,
        levels: AudioLevels,
    },
    #[serde(rename = "meeting_detected")]
    MeetingDetected { meeting: DetectedMeeting },
    #[serde(rename = "recording_started")]
    RecordingStarted {
        file_path: String,
        meeting: Option<DetectedMeeting>,
    },
    #[serde(rename = "recording_stopped")]
    RecordingStopped {
        file_path: String,
        duration_seconds: f64,
        meeting: Option<DetectedMeeting>,
    },
    #[serde(rename = "slide_captured")]
    SlideCaptured {
        file_path: String,
        filename: String,
        timecode: f64,
        timecode_formatted: String,
    },
    #[serde(rename = "timecode")]
    Timecode {
        timecode: f64,
        timecode_formatted: String,
    },
    #[serde(rename = "error")]
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "command")]
pub enum ClientCommand {
    #[serde(rename = "start")]
    Start { title: Option<String> },
    #[serde(rename = "stop")]
    Stop,
    #[serde(rename = "pause")]
    Pause,
    #[serde(rename = "resume")]
    Resume,
    #[serde(rename = "capture_slide")]
    CaptureSlide,
    #[serde(rename = "get_timecode")]
    GetTimecode,
    #[serde(rename = "ping")]
    Ping,
}

pub struct ServerContext {
    pub recorder: Arc<Mutex<AudioRecorder>>,
    pub active_meeting: Arc<Mutex<Option<DetectedMeeting>>>,
    pub dismissed_meeting_hwnds: Arc<Mutex<std::collections::HashSet<isize>>>,
    pub vault_attachments_dir: std::path::PathBuf,
    pub tx: broadcast::Sender<ServerEvent>,
}

pub async fn run_websocket_server(port: u16, ctx: Arc<ServerContext>) -> Result<(), String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("Bind WebSocket on {} failed: {}", addr, e))?;

    log::info!("Meeting recorder WebSocket listening on ws://{}", addr);

    while let Ok((stream, _)) = listener.accept().await {
        let ctx = ctx.clone();
        tokio::spawn(async move {
            handle_connection(stream, ctx).await;
        });
    }

    Ok(())
}

async fn handle_connection(stream: TcpStream, ctx: Arc<ServerContext>) {
    let ws_stream = match tokio_tungstenite::accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            log::warn!("WebSocket handshake error: {}", e);
            return;
        }
    };

    let (mut ws_sender, mut ws_receiver) = ws_stream.split();
    let mut rx = ctx.tx.subscribe();

    // Task to forward broadcast events to this client
    let send_task = tokio::spawn(async move {
        while let Ok(event) = rx.recv().await {
            if let Ok(json) = serde_json::to_string(&event) {
                if ws_sender.send(Message::Text(json)).await.is_err() {
                    break;
                }
            }
        }
    });

    // Handle incoming messages from Obsidian
    while let Some(msg) = ws_receiver.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(_) => break,
        };

        if let Message::Text(text) = msg {
            if let Ok(cmd) = serde_json::from_str::<ClientCommand>(&text) {
                handle_command(cmd, &ctx);
            }
        }
    }

    send_task.abort();
}

fn handle_command(cmd: ClientCommand, ctx: &ServerContext) {
    match cmd {
        ClientCommand::Start { title } => {
            let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
            let sanitized = title.unwrap_or_else(|| "Meeting".to_string())
                .replace(|c: char| !c.is_alphanumeric() && c != '_' && c != '-', "_");
            let filename = format!("{}_{}.wav", timestamp, sanitized);
            let path = ctx.vault_attachments_dir.join(&filename);

            let mut rec = ctx.recorder.lock();
            if rec.start(path.clone()).is_ok() {
                let _ = ctx.tx.send(ServerEvent::RecordingStarted {
                    file_path: path.to_string_lossy().to_string(),
                    meeting: ctx.active_meeting.lock().clone(),
                });
            }
        }
        ClientCommand::Stop => {
            let mut rec = ctx.recorder.lock();
            let status = rec.get_status();
            if let Some(path) = rec.stop() {
                let current_meeting = ctx.active_meeting.lock().clone();
                if let Some(ref m) = current_meeting {
                    ctx.dismissed_meeting_hwnds.lock().insert(m.hwnd);
                    log::info!("Manually stopped recording for meeting '{}' (hwnd: {}). Auto-record suppressed for this window.", m.title, m.hwnd);
                }

                let _ = ctx.tx.send(ServerEvent::RecordingStopped {
                    file_path: path.to_string_lossy().to_string(),
                    duration_seconds: status.elapsed_seconds,
                    meeting: current_meeting,
                });
            }
        }
        ClientCommand::Pause => {
            ctx.recorder.lock().pause();
        }
        ClientCommand::Resume => {
            ctx.recorder.lock().resume();
        }
        ClientCommand::CaptureSlide => {
            let status = ctx.recorder.lock().get_status();
            let elapsed = status.elapsed_seconds;
            let formatted = format_timecode(elapsed);
            let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
            let filename = format!("slide_{}_{}.png", timestamp, formatted.replace(":", "m") + "s");
            let path = ctx.vault_attachments_dir.join(&filename);

            let hwnd = ctx.active_meeting.lock().as_ref().map(|m| m.hwnd);

            match crate::screenshot::capture_screenshot(hwnd, &path) {
                Ok(saved_path) => {
                    let _ = ctx.tx.send(ServerEvent::SlideCaptured {
                        file_path: saved_path.to_string_lossy().to_string(),
                        filename,
                        timecode: elapsed,
                        timecode_formatted: formatted,
                    });
                }
                Err(e) => {
                    let _ = ctx.tx.send(ServerEvent::Error {
                        message: format!("Capture slide failed: {}", e),
                    });
                }
            }
        }
        ClientCommand::GetTimecode => {
            let status = ctx.recorder.lock().get_status();
            let elapsed = status.elapsed_seconds;
            let formatted = format_timecode(elapsed);
            let _ = ctx.tx.send(ServerEvent::Timecode {
                timecode: elapsed,
                timecode_formatted: formatted,
            });
        }
        ClientCommand::Ping => {
            // No action needed
        }
    }
}

pub fn format_timecode(seconds: f64) -> String {
    let s = seconds as u64;
    let mins = s / 60;
    let secs = s % 60;
    if mins >= 60 {
        let hrs = mins / 60;
        let rem_mins = mins % 60;
        format!("{:02}:{:02}:{:02}", hrs, rem_mins, secs)
    } else {
        format!("{:02}:{:02}", mins, secs)
    }
}
