import { Socket } from 'node:net';

export const blockedConnections = [];
export const blockedConnectionMarker = 'SMOKE_EXTERNAL_CONNECTION_BLOCKED';
export const isLoopback = (host) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);

const connect = Socket.prototype.connect;

// A broken follower/authentication path must fail the smoke without reaching TikTok or GCP.
Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof first === 'object'
    ? (first.host ?? 'localhost')
    : (typeof args[1] === 'string' ? args[1] : 'localhost');
  if (!isLoopback(host)) {
    const error = new Error(`${blockedConnectionMarker}: ${host}`);
    blockedConnections.push(error);
    console.error(error.message);
    throw error;
  }
  return connect.apply(this, args);
};
