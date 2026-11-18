import { initializeApp } from 'firebase-admin/app';

/**
 * The default Firebase app is created **once**, here.
 *
 * Every module that talks to Firestore imports this file **first**, so the
 * app exists by the time the body of those modules runs. The modules use
 * `getFirestore()` at the top level, and that call needs the app to be
 * there already.
 *
 * The reason this file exists: `import` statements are evaluated before
 * the rest of the module, so a plain `initializeApp()` in the entry
 * point (`index.ts`) ran **after** the imported modules had already tried
 * to open Firestore — and the deployment failed with
 * "The default Firebase app does not exist".
 */
initializeApp();
