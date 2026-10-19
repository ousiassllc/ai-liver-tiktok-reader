import { describe, it, expect } from 'bun:test';
import { extractUsername } from '../../src/utils/url-parser';

describe('URL Parser', () => {
  describe('extractUsername', () => {
    it('should extract username from standard TikTok Live URL', () => {
      const url = 'https://www.tiktok.com/@testuser/live';
      const result = extractUsername(url);
      expect(result).toBe('testuser');
    });

    it('should extract username from TikTok Live URL without www', () => {
      const url = 'https://tiktok.com/@johndoe/live';
      const result = extractUsername(url);
      expect(result).toBe('johndoe');
    });

    it('should extract username from @username format', () => {
      const url = '@myusername';
      const result = extractUsername(url);
      expect(result).toBe('myusername');
    });

    it('should extract username from plain username', () => {
      const url = 'plainusername';
      const result = extractUsername(url);
      expect(result).toBe('plainusername');
    });

    it('should handle username with numbers', () => {
      const url = 'https://www.tiktok.com/@user123/live';
      const result = extractUsername(url);
      expect(result).toBe('user123');
    });

    it('should handle username with underscores', () => {
      const url = 'https://www.tiktok.com/@user_name_123/live';
      const result = extractUsername(url);
      expect(result).toBe('user_name_123');
    });

    it('should return empty string for invalid URL without @', () => {
      const url = 'https://www.tiktok.com/live';
      const result = extractUsername(url);
      expect(result).toBe('');
    });

    it('should return empty string for URL with slash but no @', () => {
      const url = 'https://example.com/somepath';
      const result = extractUsername(url);
      expect(result).toBe('');
    });

    it('should handle empty string', () => {
      const url = '';
      const result = extractUsername(url);
      expect(result).toBe('');
    });

    it('should extract first username when multiple @ symbols exist', () => {
      const url = 'https://www.tiktok.com/@firstuser/@seconduser';
      const result = extractUsername(url);
      expect(result).toBe('firstuser');
    });

    it('should handle URLs with query parameters', () => {
      const url = 'https://www.tiktok.com/@testuser/live?lang=en';
      const result = extractUsername(url);
      expect(result).toBe('testuser');
    });
  });
});
