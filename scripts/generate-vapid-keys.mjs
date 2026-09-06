#!/usr/bin/env node
// Print a fresh VAPID key pair for Web Push (issue #9). Run once, then set the
// two values on the host (Render dashboard) and in your local .env:
//
//   node scripts/generate-vapid-keys.mjs
//
// The public key is safe to ship to browsers (GET /api/push/config returns it);
// the private key signs every push request and must stay secret. Rotating the
// pair invalidates every existing subscription, so users would need to turn
// notifications on again.
import { generateVapidKeys } from '../src/webPush.mjs'

const { publicKey, privateKey } = generateVapidKeys()
console.log('# Add these to .env locally and to the Render environment (issue #9):')
console.log(`VAPID_PUBLIC_KEY=${publicKey}`)
console.log(`VAPID_PRIVATE_KEY=${privateKey}`)
console.log('VAPID_SUBJECT=mailto:support@boilerindy.app')
