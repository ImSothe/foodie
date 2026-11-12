foodie · vendored barcode reader (used only when the browser has no native BarcodeDetector)

Files (app/vendor/lazy/, fetched on first use and cached by the service worker; never part of the first load or the precache):
  barcode-detector.js   43566 bytes, 15344 gzipped   SHA-256 fe847e980993df8ba2ee1f7020717590d79925c83c56c570bb824a170b877084
  zxing_reader.wasm     946860 bytes, 411570 gzipped   SHA-256 5003fb4b88c4fbd1fd518a2fd8c8ad365c519e183a08c03a322dddfea3cea84e
Packages:  barcode-detector 3.2.3 (MIT, see LICENSE-barcode-detector.txt)
           zxing-wasm 3.1.6 (MIT, see LICENSE-zxing-wasm.txt), a build of ZXing-C++ (Apache License 2.0,
           https://github.com/zxing-cpp/zxing-cpp), compiled with Emscripten
Bundler:   esbuild 0.28.2
Command:   node tools/vendor_barcode.mjs
           (npm install barcode-detector@3.2.3 in a temporary folder, then
            npx --yes esbuild@0.28.2 entry.js --bundle --format=esm --minify --target=es2022 --legal-comments=none,
            entry.js re-exporting BarcodeDetector and setZXingModuleOverrides from 'barcode-detector/ponyfill')
Note:      the ponyfill downloads its WebAssembly from a CDN by default; foodie overrides that with setZXingModuleOverrides so the
           file above is served from the app's own origin (app/data/scanner.js).
           Instantiating WebAssembly needs 'wasm-unsafe-eval' in the Content Security Policy (see SECURITY.md).
