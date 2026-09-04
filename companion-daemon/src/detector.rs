use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use serde::{Deserialize, Serialize};
use windows::core::PWSTR;
use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DetectedMeeting {
    pub app: String,
    pub title: String,
    pub hwnd: isize,
    pub pid: u32,
}

struct EnumContext {
    meetings: Vec<DetectedMeeting>,
}

pub fn scan_for_meetings() -> Option<DetectedMeeting> {
    let mut ctx = EnumContext {
        meetings: Vec::new(),
    };

    unsafe {
        let lparam = LPARAM(&mut ctx as *mut EnumContext as isize);
        let _ = EnumWindows(Some(enum_window_callback), lparam);
    }

    // Return the first detected meeting if any
    ctx.meetings.into_iter().next()
}

unsafe extern "system" fn enum_window_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if !IsWindowVisible(hwnd).as_bool() {
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

    let mut detected_app: Option<&str> = None;

    // 1. Microsoft Teams
    if process_name.contains("teams") || process_name.contains("ms-teams") {
        let is_non_meeting_tab = title_lower.starts_with("calendar")
            || title_lower.starts_with("chat")
            || title_lower.starts_with("activity")
            || title_lower.starts_with("teams |")
            || title_lower.starts_with("calls |")
            || title_lower.starts_with("files |")
            || title_lower.starts_with("apps |")
            || title_lower.starts_with("assignments |");

        let is_actual_call = title_lower.contains("meeting")
            || title_lower.contains("call")
            || title_lower.contains("huddle")
            || title_lower.ends_with(", meeting")
            || title_lower.ends_with(", call");

        if !is_non_meeting_tab && is_actual_call {
            detected_app = Some("Microsoft Teams");
        }
    }
    // 2. Zoom
    else if process_name.contains("zoom")
        && (title_lower.contains("zoom meeting") || title_lower.contains("zoom webinar"))
    {
        detected_app = Some("Zoom");
    }
    // 3. Google Meet (Browser Tab in Chrome, Edge, Brave, Firefox)
    else if (process_name.contains("chrome")
        || process_name.contains("msedge")
        || process_name.contains("brave")
        || process_name.contains("firefox"))
        && title_lower.contains("meet - ")
    {
        detected_app = Some("Google Meet");
    }
    // 4. Slack Huddle
    else if process_name.contains("slack") && title_lower.contains("huddle") {
        detected_app = Some("Slack Huddle");
    }
    // 5. Cisco Webex
    else if (process_name.contains("webex") || process_name.contains("ciscocollabhost"))
        && title_lower.contains("webex")
    {
        detected_app = Some("Cisco Webex");
    }

    if let Some(app) = detected_app {
        let ctx = &mut *(lparam.0 as *mut EnumContext);
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
