use std::path::{Path, PathBuf};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
    GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    SRCCOPY,
};
use windows::Win32::UI::WindowsAndMessaging::{GetClientRect, GetDesktopWindow, GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};

pub fn capture_screenshot(target_hwnd: Option<isize>, output_path: &Path) -> Result<PathBuf, String> {
    unsafe {
        let (hwnd, width, height) = if let Some(h) = target_hwnd {
            let win_hwnd = HWND(h as *mut _);
            let mut rect = RECT::default();
            if GetClientRect(win_hwnd, &mut rect).is_ok() && (rect.right - rect.left) > 100 {
                (win_hwnd, (rect.right - rect.left) as i32, (rect.bottom - rect.top) as i32)
            } else {
                let desk = GetDesktopWindow();
                let w = GetSystemMetrics(SM_CXSCREEN);
                let h = GetSystemMetrics(SM_CYSCREEN);
                (desk, w, h)
            }
        } else {
            let desk = GetDesktopWindow();
            let w = GetSystemMetrics(SM_CXSCREEN);
            let h = GetSystemMetrics(SM_CYSCREEN);
            (desk, w, h)
        };

        if width <= 0 || height <= 0 {
            return Err("Invalid window or screen dimensions".to_string());
        }

        let hdc_window = GetDC(hwnd);
        if hdc_window.is_invalid() {
            return Err("GetDC failed".to_string());
        }

        let hdc_mem = CreateCompatibleDC(hdc_window);
        let hbm = CreateCompatibleBitmap(hdc_window, width, height);
        let old_hbm = SelectObject(hdc_mem, hbm);

        let blt_res = BitBlt(hdc_mem, 0, 0, width, height, hdc_window, 0, 0, SRCCOPY);
        if blt_res.is_err() {
            let _ = SelectObject(hdc_mem, old_hbm);
            let _ = DeleteObject(hbm);
            let _ = DeleteDC(hdc_mem);
            let _ = ReleaseDC(hwnd, hdc_window);
            return Err("BitBlt failed".to_string());
        }

        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height, // top-down DIB
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };

        let mut bgra_pixels = vec![0u8; (width * height * 4) as usize];
        let lines_copied = GetDIBits(
            hdc_mem,
            hbm,
            0,
            height as u32,
            Some(bgra_pixels.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        );

        // Cleanup GDI objects
        let _ = SelectObject(hdc_mem, old_hbm);
        let _ = DeleteObject(hbm);
        let _ = DeleteDC(hdc_mem);
        let _ = ReleaseDC(hwnd, hdc_window);

        if lines_copied == 0 {
            return Err("GetDIBits failed to copy pixels".to_string());
        }

        // Convert BGRA to RGBA
        let mut rgba_pixels = vec![0u8; (width * height * 4) as usize];
        for i in (0..bgra_pixels.len()).step_by(4) {
            rgba_pixels[i] = bgra_pixels[i + 2];     // R
            rgba_pixels[i + 1] = bgra_pixels[i + 1]; // G
            rgba_pixels[i + 2] = bgra_pixels[i];     // B
            rgba_pixels[i + 3] = 255;                // A
        }

        if let Some(parent) = output_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        image::save_buffer(
            output_path,
            &rgba_pixels,
            width as u32,
            height as u32,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| format!("Save PNG failed: {}", e))?;

        log::info!("Screenshot saved -> {:?}", output_path);
        Ok(output_path.to_path_buf())
    }
}
