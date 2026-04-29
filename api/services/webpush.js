'use strict';

const webpush = require('web-push');
const path    = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

let initialized = false;

function init() {
  if (initialized) return;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.warn('[webpush] VAPID keys not set — push notifications disabled');
    return;
  }
  webpush.setVapidDetails(
    VAPID_SUBJECT || 'mailto:admin@poser.app',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
  initialized = true;
}

init();

async function sendPush(subscription, payload) {
  if (!initialized) return;
  return webpush.sendNotification(subscription, JSON.stringify(payload));
}

function getVapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

module.exports = { sendPush, getVapidPublicKey };
