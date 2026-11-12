foodie · vendored Firebase web SDK

File:      firebase.js  (one ES module, minified)
Contents:  firebase/app, firebase/auth (Google popup), firebase/firestore/lite, firebase/app-check (reCAPTCHA Enterprise) and firebase/ai
           (Firebase AI Logic, Gemini Developer API), bundled with their dependencies
Versions:  firebase 13.3.0, esbuild 0.28.2
Command:   node tools/vendor_firebase.mjs
           (npm install firebase@13.3.0 in a temporary folder, then
            npx --yes esbuild@0.28.2 entry.js --bundle --format=esm --minify --target=es2022 --legal-comments=none)
SHA-256:   739293a6af57ad5628a04efd265f170134dea8a00e10458b7858996be9a9ace3
Size:      273381 bytes, 83476 bytes gzipped
Licence:   Apache License 2.0, see LICENSE-firebase.txt (copyright Google LLC and the Firebase authors)

Packages bundled (name, version, licence):
  @firebase/ai 3.1.0 Apache-2.0
  @firebase/app 0.16.6 Apache-2.0
  @firebase/app-check 0.13.1 Apache-2.0
  @firebase/auth 1.13.10 Apache-2.0
  @firebase/component 0.7.5 Apache-2.0
  @firebase/firestore 4.20.0 Apache-2.0
  @firebase/logger 0.5.2 Apache-2.0
  @firebase/util 1.15.3 Apache-2.0
  @firebase/webchannel-wrapper 1.0.7 Apache-2.0
  firebase 13.3.0 Apache-2.0
  idb 7.1.1 ISC
  tslib 2.9.1 0BSD

The app loads this file with a dynamic import() only when the user chooses to sign in (or was signed in before),
so it costs nothing for everyone else. Update it by changing the versions at the top of tools/vendor_firebase.mjs,
running the command above and committing the new files together with a note in this file.
