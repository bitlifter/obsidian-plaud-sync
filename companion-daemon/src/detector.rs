use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use serde::{Deserialize, Serialize};
use windows::core::{Interface, PWSTR};
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    IsWindowVisible, IsIconic, GetWindowRect, GetWindowLongW, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::Media::Audio::{
    IAudioSessionManager2, IAudioSessionControl2, AudioSessionStateActive,
    IMMDeviceEnumerator, MMDeviceEnumerator, eRender, eMultimedia,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DetectedMeeting {
    pub app: String,
    pub title: String,
    pub hwnd: isize,
    pub pid: u32,
}

struct EnumContext {
    active_audio_procs: Vec<String>,
    meetings: Vec<DetectedMeeting>,
}

pub fn scan_for_meetings() -> Option<DetectedMeeting> {
    let active_audio_procs = get_active_audio_processes();

    let mut ctx = EnumContext {
        active_audio_procs,
        meetings: Vec::new(),
    };

    unsafe {
        let lparam = LPARAM(&mut ctx as *mut EnumContext as isize);
        let _ = EnumWindows(Some(enum_window_callback), lparam);
    }

    ctx.meetings.into_iter().next()
}

unsafe fn is_genuine_window(hwnd: HWND) -> bool {
    // 1. Must have WS_VISIBLE style
    if !IsWindowVisible(hwnd).as_bool() {
        return false;
    }

    // 2. Must not be minimized / iconic
    if IsIconic(hwnd).as_bool() {
        return false;
    }

    // 3. Must not be a tool window (floating helpers, notification toasts, tray flyouts)
    let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    if (ex_style & WS_EX_TOOLWINDOW.0) != 0 {
        return false;
    }

    // 4. Must not be cloaked by DWM (suspended UWP or virtual desktop hidden)
    let mut cloaked: u32 = 0;
    if DwmGetWindowAttribute(
        hwnd,
        DWMWA_CLOAKED,
        &mut cloaked as *mut _ as *mut _,
        std::mem::size_of::<u32>() as u32,
    ).is_ok() && cloaked != 0 {
        return false;
    }

    // 5. Must have genuine desktop window dimensions (>= 320x240 and on-screen)
    let mut rect = RECT::default();
    if GetWindowRect(hwnd, &mut rect).is_ok() {
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width < 320 || height < 240 {
            return false;
        }
        if rect.right <= 0 || rect.bottom <= 0 || rect.left < -10000 || rect.top < -10000 {
            return false;
        }
    }

    true
}

pub fn get_active_audio_processes() -> Vec<String> {
    let mut procs = Vec::new();
    unsafe {
        let Ok(enumerator) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) else {
            return procs;
        };
        let Ok(device) = enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia) else {
            return procs;
        };
        let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
            return procs;
        };
        let Ok(session_enum) = manager.GetSessionEnumerator() else {
            return procs;
        };
        let count = session_enum.GetCount().unwrap_or(0);
        for i in 0..count {
            if let Ok(control) = session_enum.GetSession(i) {
                if let Ok(control2) = control.cast::<IAudioSessionControl2>() {
                    if let Ok(state) = control2.GetState() {
                        if state == AudioSessionStateActive {
                            if let Ok(pid) = control2.GetProcessId() {
                                if let Some(name) = get_process_name(pid) {
                                    procs.push(name.to_lowercase());
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    procs
}

unsafe extern "system" fn enum_window_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if !is_genuine_window(hwnd) {
        return BOOL(1);
    }

    let len = GetWindowTextLengthW(hwnd);
    if len == 0 {
        return BOOL(1);
    }

    let mut buf: Vec<u16> = vec![0; (len + 1) as usize];
    let copied = GetWindowTextW(hwnd, &mut buf);
    if copied == 0 {
        return BOOL(1);
    }

    let title = OsString::from_wide(&buf[..copied as usize])
        .to_string_lossy()
        .trim()
        .to_string();

    if title.is_empty() {
        return BOOL(1);
    }

    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));

    let process_name = get_process_name(pid).unwrap_or_default().to_lowercase();
    let title_lower = title.to_lowercase();
    let ctx = &mut *(lparam.0 as *mut EnumContext);

    let has_active_audio = |target: &str| {
        ctx.active_audio_procs.iter().any(|p| p.contains(target))
    };

    let mut detected_app: Option<&str> = None;

    // 1. Microsoft Teams
    if process_name.contains("teams") || process_name.contains("ms-teams") {
        // Exclude general navigation tabs and main window when just browsing
        let is_general_nav = title_lower == "microsoft teams"
            || title_lower.starts_with("calendar |")
            || title_lower.starts_with("chat |")
            || title_lower.starts_with("activity |")
            || title_lower.starts_with("teams |")
            || title_lower.starts_with("calls |")
            || title_lower.starts_with("files |")
            || title_lower.starts_with("apps |")
            || title_lower.starts_with("assignments |");

        // Explicit call/meeting markers in window title
        let has_explicit_call_title = title_lower.contains(", meeting")
            || title_lower.contains(", call")
            || title_lower.contains("meeting |")
            || title_lower.starts_with("meeting in ")
            || title_lower.contains("call with ")
            || title_lower.ends_with("call");

        let teams_audio_active = has_active_audio("teams");

        // Teams is only considered a meeting if:
        // - It has an active audio stream and is not purely a navigation tab, OR
        // - The title explicitly indicates a popped-out meeting/call window
        if (!is_general_nav && teams_audio_active) || has_explicit_call_title {
            detected_app = Some("Microsoft Teams");
        }
    }
    // 2. Zoom (Must be zoom.exe / zoomworkplace.exe, genuine window >= 400x300, and meeting/webinar title)
    else if (process_name == "zoom.exe" || process_name == "zoomworkplace.exe" || process_name == "ciscowebexzoom.exe")
        && (title_lower.starts_with("zoom meeting") || title_lower.contains("zoom meeting") || title_lower.contains("zoom webinar"))
    {
        // Ignore main dashboard "Zoom Workplace" or "Zoom" without meeting
        if !title_lower.starts_with("zoom workplace") && !title_lower.starts_with("zoom cloud meetings") {
            detected_app = Some("Zoom");
        }
    }
    // 3. Google Meet (Browser Tab in Chrome, Edge, Brave, Firefox)
    else if (process_name.contains("chrome")
        || process_name.contains("msedge")
        || process_name.contains("brave")
        || process_name.contains("firefox"))
        && (title_lower.starts_with("meet - ") || title_lower.contains("meet - "))
    {
        detected_app = Some("Google Meet");
    }
    // 4. Slack Huddle
    else if process_name.contains("slack") && title_lower.contains("huddle") {
        detected_app = Some("Slack Huddle");
    }
    // 5. Cisco Webex
    else if (process_name.contains("webex") || process_name.contains("ciscocollabhost"))
        && (title_lower.contains("webex meeting") || title_lower.contains("webex personal room"))
    {
        detected_app = Some("Cisco Webex");
    }

    if let Some(app) = detected_app {
        ctx.meetings.push(DetectedMeeting {
            app: app.to_string(),
            title,
            hwnd: hwnd.0 as isize,
            pid,
        });
        // Stop enumeration once found
        return BOOL(0);
    }

    BOOL(1)
}

fn get_process_name(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u16; 1024];
        let mut size = buf.len() as u32;

        let res = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT(0),
            PWSTR(buf.as_mut_ptr()),
            &mut size,
        );

        let _ = windows::Win32::Foundation::CloseHandle(handle);

        if res.is_ok() && size > 0 {
            let full_path = OsString::from_wide(&buf[..size as usize]).to_string_lossy().to_string();
            let name = std::path::Path::new(&full_path)
                .file_name()
                .map(|f| f.to_string_lossy().to_string());
            return name;
        }
        None
    }
}
