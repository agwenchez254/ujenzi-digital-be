export const ALLOWED_PUSH_ENDPOINT_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'notify.windows.com',
  'push.apple.com',
];

export function isAllowedPushEndpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') {
    return false;
  }
  return ALLOWED_PUSH_ENDPOINT_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}
