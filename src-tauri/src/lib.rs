#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // In production, the app is loaded from the `tauri://localhost` (or `http(s)://tauri.localhost`)
    // protocol. To enable `SharedArrayBuffer` / `crossOriginIsolated` for Ultra's shared-TT search,
    // we must serve COOP/COEP headers on the main document (and we apply them to all assets).
    //
    // NOTE: In dev, the frontend is loaded from `devUrl` (Vite), which already sets these headers.
    let builder = tauri::Builder::default();

    #[cfg(not(dev))]
    let builder = builder.register_uri_scheme_protocol("tauri", |ctx, request| {
        let path = request.uri().path().to_string();
        let asset = ctx.app_handle().asset_resolver().get(path);

        let mut response = tauri::http::Response::builder()
            .header("Cross-Origin-Opener-Policy", "same-origin")
            .header("Cross-Origin-Embedder-Policy", "require-corp");

        if let Some(asset) = asset {
            response = response.header(tauri::http::header::CONTENT_TYPE, asset.mime_type());
            if let Some(csp) = asset.csp_header() {
                response = response.header("Content-Security-Policy", csp);
            }
            response.body(asset.bytes().to_vec()).unwrap()
        } else {
            response
                .status(tauri::http::StatusCode::NOT_FOUND)
                .header(tauri::http::header::CONTENT_TYPE, "text/plain")
                .body(b"Not Found".to_vec())
                .unwrap()
        }
    });

    builder
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

