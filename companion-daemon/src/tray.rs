use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use tokio::sync::broadcast;
use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Shell::{
    Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_MODIFY,
    NOTIFYICONDATAW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreateIcon, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyMenu,
    DestroyWindow, DispatchMessageW, GetCursorPos, GetMessageW, LoadIconW, PostMessageW,
    PostQuitMessage, RegisterClassW, SetForegroundWindow, TrackPopupMenuEx, HICON,
    IDI_APPLICATION, MF_CHECKED, MF_DISABLED, MF_GRAYED, MF_SEPARATOR, MF_STRING, MF_UNCHECKED,
    MSG, TPM_BOTTOMALIGN, TPM_RIGHTBUTTON, WINDOW_EX_STYLE, WM_COMMAND, WM_CREATE, WM_DESTROY,
    WM_NULL, WM_RBUTTONUP, WM_USER, WNDCLASSW, WS_OVERLAPPEDWINDOW,
};

use crate::audio::AudioRecorder;
use crate::detector::DetectedMeeting;
use crate::server::ServerEvent;

const WM_TRAYICON: u32 = WM_USER + 100;

const IDM_STATUS: usize = 2001;
const IDM_TOGGLE_FEATURE: usize = 2002;
const IDM_STOP_RECORDING: usize = 2003;
const IDM_EXIT: usize = 2004;

pub struct TrayContext {
    pub feature_enabled: Arc<AtomicBool>,
    pub recorder: Arc<Mutex<AudioRecorder>>,
    pub active_meeting: Arc<Mutex<Option<DetectedMeeting>>>,
    pub dismissed_meeting_hwnds: Arc<Mutex<std::collections::HashSet<isize>>>,
    pub tx: broadcast::Sender<ServerEvent>,
}

static TRAY_CTX: RwLock<Option<Arc<TrayContext>>> = RwLock::new(None);
static TRAY_HWND: AtomicIsize = AtomicIsize::new(0);

/// Create a circular colored 16x16 icon in memory (RGB)
fn create_circle_icon(r: u8, g: u8, b: u8) -> HICON {
    unsafe {
        let hinstance = GetModuleHandleW(None).unwrap_or_default();
        let mut and_mask = [0xFFu8; 32]; // 16x16 1-bit mask (2 bytes per row * 16 rows)
        let mut xor_mask = [0u8; 16 * 16 * 4]; // 16x16 32-bit BGRA

        let center = 7.5f32;
        let radius = 6.0f32;
        let radius_sq = radius * radius;

        for y in 0..16 {
            let dy = y as f32 - center;
            for x in 0..16 {
                let dx = x as f32 - center;
                let dist_sq = dx * dx + dy * dy;

                if dist_sq <= radius_sq {
                    // Pixel is inside circle: unmask in AND mask (0 = draw XOR)
                    let byte_idx = (y * 2) + (x / 8);
                    let bit_idx = 7 - (x % 8);
                    and_mask[byte_idx] &= !(1 << bit_idx);

                    let pixel_idx = (y * 16 + x) * 4;
                    // Add subtle shading: slightly lighter top-left, darker bottom-right
                    let shade = 1.0 - (dy * 0.05);
                    xor_mask[pixel_idx] = (b as f32 * shade).clamp(0.0, 255.0) as u8;     // Blue
                    xor_mask[pixel_idx + 1] = (g as f32 * shade).clamp(0.0, 255.0) as u8; // Green
                    xor_mask[pixel_idx + 2] = (r as f32 * shade).clamp(0.0, 255.0) as u8; // Red
                    xor_mask[pixel_idx + 3] = 255;                                         // Alpha
                }
            }
        }

        CreateIcon(
            hinstance,
            16,
            16,
            1,
            32,
            and_mask.as_ptr(),
            xor_mask.as_ptr(),
        )
        .unwrap_or_else(|_| LoadIconW(None, IDI_APPLICATION).unwrap_or_default())
    }
}

pub fn update_tray_status(is_recording: bool, feature_enabled: bool, meeting_title: Option<&str>) {
    let hwnd_raw = TRAY_HWND.load(Ordering::Relaxed);
    if hwnd_raw == 0 {
        return;
    }
    let hwnd = HWND(hwnd_raw as _);

    let tip = if is_recording {
        format!(
            "Obsidian Recorder: Recording {}",
            meeting_title.unwrap_or("Meeting")
        )
    } else if feature_enabled {
        "Obsidian Meeting Recorder (Active)".to_string()
    } else {
        "Obsidian Meeting Recorder (Disabled)".to_string()
    };

    let icon = if is_recording {
        create_circle_icon(239, 68, 68) // Red
    } else if feature_enabled {
        create_circle_icon(124, 58, 237) // Purple
    } else {
        create_circle_icon(156, 163, 175) // Gray
    };

    let mut nid = NOTIFYICONDATAW {
        cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
        hWnd: hwnd,
        uID: 1,
        uFlags: NIF_TIP | NIF_ICON,
        hIcon: icon,
        ..Default::default()
    };

    for (i, c) in tip.encode_utf16().enumerate().take(127) {
        nid.szTip[i] = c;
    }

    unsafe {
        let _ = Shell_NotifyIconW(NIM_MODIFY, &nid);
    }
}

fn remove_tray_icon(hwnd: HWND) {
    let nid = NOTIFYICONDATAW {
        cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
        hWnd: hwnd,
        uID: 1,
        ..Default::default()
    };
    unsafe {
        let _ = Shell_NotifyIconW(NIM_DELETE, &nid);
    }
}

unsafe extern "system" fn tray_wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_CREATE => {
            TRAY_HWND.store(hwnd.0 as isize, Ordering::SeqCst);
            let icon = create_circle_icon(124, 58, 237);
            let mut nid = NOTIFYICONDATAW {
                cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
                hWnd: hwnd,
                uID: 1,
                uFlags: NIF_MESSAGE | NIF_ICON | NIF_TIP,
                uCallbackMessage: WM_TRAYICON,
                hIcon: icon,
                ..Default::default()
            };

            let tip = "Obsidian Meeting Recorder (Active)";
            for (i, c) in tip.encode_utf16().enumerate().take(127) {
                nid.szTip[i] = c;
            }

            let _ = Shell_NotifyIconW(NIM_ADD, &nid);
            LRESULT(0)
        }
        WM_TRAYICON => {
            let event = lparam.0 as u32;
            if event == WM_RBUTTONUP {
                let mut pt = POINT::default();
                let _ = GetCursorPos(&mut pt);
                let _ = SetForegroundWindow(hwnd);

                if let Ok(menu) = CreatePopupMenu() {
                    let ctx_opt = TRAY_CTX.read().clone();
                    if let Some(ctx) = ctx_opt {
                        let feature_enabled = ctx.feature_enabled.load(Ordering::Relaxed);
                        let is_recording = ctx.recorder.lock().get_status().is_recording;
                        let meeting = ctx.active_meeting.lock().clone();

                        let status_text = if is_recording {
                            format!(
                                "● Recording: {}",
                                meeting
                                    .map(|m| m.title)
                                    .unwrap_or_else(|| "Meeting".to_string())
                            )
                        } else if feature_enabled {
                            "○ Meeting Recorder: Ready".to_string()
                        } else {
                            "✕ Meeting Recorder: Disabled".to_string()
                        };

                        let _ = AppendMenuW(
                            menu,
                            MF_STRING | MF_GRAYED | MF_DISABLED,
                            IDM_STATUS,
                            &HSTRING::from(status_text),
                        );
                        let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());

                        let toggle_flags = MF_STRING
                            | (if feature_enabled {
                                MF_CHECKED
                            } else {
                                MF_UNCHECKED
                            });
                        let _ = AppendMenuW(
                            menu,
                            toggle_flags,
                            IDM_TOGGLE_FEATURE,
                            w!("Recording Feature Enabled"),
                        );

                        if is_recording {
                            let _ = AppendMenuW(
                                menu,
                                MF_STRING,
                                IDM_STOP_RECORDING,
                                w!("Stop Current Recording"),
                            );
                        }

                        let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
                        let _ = AppendMenuW(menu, MF_STRING, IDM_EXIT, w!("Exit Companion App"));

                        let _ = TrackPopupMenuEx(
                            menu,
                            (TPM_RIGHTBUTTON | TPM_BOTTOMALIGN).0,
                            pt.x,
                            pt.y,
                            hwnd,
                            None,
                        );
                        let _ = DestroyMenu(menu);
                        let _ = PostMessageW(hwnd, WM_NULL, WPARAM(0), LPARAM(0));
                    }
                }
            }
            LRESULT(0)
        }
        WM_COMMAND => {
            let cmd_id = (wparam.0 & 0xFFFF) as usize;
            match cmd_id {
                IDM_TOGGLE_FEATURE => {
                    let ctx_opt = TRAY_CTX.read().clone();
                    if let Some(ctx) = ctx_opt {
                        let current = ctx.feature_enabled.load(Ordering::SeqCst);
                        let new_state = !current;
                        ctx.feature_enabled.store(new_state, Ordering::SeqCst);

                        if !new_state {
                            let mut rec = ctx.recorder.lock();
                            let status = rec.get_status();
                            if let Some(path) = rec.stop() {
                                let current_meeting = ctx.active_meeting.lock().clone();
                                let _ = ctx.tx.send(ServerEvent::RecordingStopped {
                                    file_path: path.to_string_lossy().to_string(),
                                    duration_seconds: status.elapsed_seconds,
                                    meeting: current_meeting,
                                });
                            }
                        }

                        let _ = ctx.tx.send(ServerEvent::FeatureToggled { enabled: new_state });
                        update_tray_status(false, new_state, None);
                        log::info!("Recording feature toggled to: {}", new_state);
                    }
                }
                IDM_STOP_RECORDING => {
                    let ctx_opt = TRAY_CTX.read().clone();
                    if let Some(ctx) = ctx_opt {
                        let mut rec = ctx.recorder.lock();
                        let status = rec.get_status();
                        if let Some(path) = rec.stop() {
                            let current_meeting = ctx.active_meeting.lock().clone();
                            if let Some(ref m) = current_meeting {
                                ctx.dismissed_meeting_hwnds.lock().insert(m.hwnd);
                            }
                            let _ = ctx.tx.send(ServerEvent::RecordingStopped {
                                file_path: path.to_string_lossy().to_string(),
                                duration_seconds: status.elapsed_seconds,
                                meeting: current_meeting,
                            });
                        }
                        update_tray_status(false, ctx.feature_enabled.load(Ordering::Relaxed), None);
                    }
                }
                IDM_EXIT => {
                    log::info!("Exit requested via system tray context menu.");
                    let ctx_opt = TRAY_CTX.read().clone();
                    if let Some(ctx) = ctx_opt {
                        let mut rec = ctx.recorder.lock();
                        let status = rec.get_status();
                        if let Some(path) = rec.stop() {
                            let current_meeting = ctx.active_meeting.lock().clone();
                            let _ = ctx.tx.send(ServerEvent::RecordingStopped {
                                file_path: path.to_string_lossy().to_string(),
                                duration_seconds: status.elapsed_seconds,
                                meeting: current_meeting,
                            });
                        }
                    }
                    remove_tray_icon(hwnd);
                    let _ = DestroyWindow(hwnd);
                    PostQuitMessage(0);
                    std::process::exit(0);
                }
                _ => {}
            }
            LRESULT(0)
        }
        WM_DESTROY => {
            remove_tray_icon(hwnd);
            TRAY_HWND.store(0, Ordering::SeqCst);
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

pub fn spawn_tray(ctx: Arc<TrayContext>) {
    *TRAY_CTX.write() = Some(ctx);

    std::thread::spawn(|| unsafe {
        let hinstance = GetModuleHandleW(None).unwrap_or_default();
        let class_name = w!("ObsidianMeetingRecorderTrayClass");

        let wc = WNDCLASSW {
            lpfnWndProc: Some(tray_wnd_proc),
            hInstance: hinstance.into(),
            lpszClassName: PCWSTR(class_name.as_ptr()),
            ..Default::default()
        };

        RegisterClassW(&wc);

        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class_name,
            w!("Obsidian Meeting Recorder"),
            WS_OVERLAPPEDWINDOW,
            0,
            0,
            0,
            0,
            None,
            None,
            hinstance,
            None,
        );

        if hwnd.is_err() {
            log::error!("Failed to create tray window");
            return;
        }

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = windows::Win32::UI::WindowsAndMessaging::TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
}
