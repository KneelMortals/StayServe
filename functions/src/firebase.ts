import * as admin from 'firebase-admin';

/**
 * The default Firebase app is created **once**, here.
 *
 * Every module that talks to Firestore imports this file **first**, so the
 * app exists by the time the body of those modules runs. The modules use
 * `admin.firestore()` at the top level, and that call needs the app to be
 * there already.
 *
 * The reason this file exists: `import` statements are evaluated before
 * the rest of the module, so a plain `admin.initializeApp()` in the entry
 * point (`index.ts`) ran **after** the imported modules had already tried
 * to open Firestore — and the deployment failed with
 * "The default Firebase app does not exist".
 */
admin.initializeApp();

export { admin };
