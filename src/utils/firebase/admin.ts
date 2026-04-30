import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore, Firestore } from "firebase-admin/firestore";
import dotenv from "dotenv";

dotenv.config();

// Initialize Firebase Admin SDK
function initializeFirebaseAdmin(): void {
  if (getApps().length === 0) {
    const serviceAccount: any = {
      type: "service_account",
      project_id: process.env.FIREBASE_PROJECT_ID!,
      private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID!,
      privateKey: process.env.FIREBASE_PRIVATE_KEY
        ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/gm, "\n").replace(/['"]/g, "")
        : undefined,
      client_email: process.env.FIREBASE_CLIENT_EMAIL!,
      client_id: process.env.FIREBASE_CLIENT_ID!,
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${process.env.FIREBASE_CLIENT_EMAIL}`,
    };

    initializeApp({
      credential: cert(serviceAccount),
      projectId: process.env.FIREBASE_PROJECT_ID!,
    });
  }
}

// Get Firestore instance
export function getAdminFirestore(): Firestore {
  initializeFirebaseAdmin();
  return getFirestore();
}

export { initializeFirebaseAdmin };
