export function extractUsername(liveUrl: string): string {
  const match = liveUrl.match(/@([^/]+)/);

  if (match) {
    return match[1];
  }

  if (!liveUrl.includes('/') && !liveUrl.includes('http')) {
    return liveUrl;
  }

  return '';
}
