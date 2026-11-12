/* Firebase web configuration of the foodie project.
   These values identify the project to Google's servers; they are public by design (every Firebase web app ships them)
   and they are NOT credentials. What protects the data is firestore.rules: only a signed-in user can touch their own documents. */
export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDNTBSjaQAPjCNNNDlcBmyOoShcKIz89ZE',
  authDomain: 'foodie-6b6da.firebaseapp.com',
  projectId: 'foodie-6b6da',
  storageBucket: 'foodie-6b6da.firebasestorage.app',
  messagingSenderId: '1002575178330',
  appId: '1:1002575178330:web:28908d221c7526b0518663',
};

/* The reCAPTCHA Enterprise (Fraud Defense) site key that App Check uses to prove that a request to Firebase AI Logic comes from this web app.
   Like the config above it is public by design (it ships to every browser); the secret half stays in the Firebase console.
   If it were empty the photo analysis would say "La IA no está configurada todavía" instead of failing. */
export const APP_CHECK_SITE_KEY = '6LcZbB0uAAAAACTr-zdEyvpWn0ZJDYO-VO5arj4k';
