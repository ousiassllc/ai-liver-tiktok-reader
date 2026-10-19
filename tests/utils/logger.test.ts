import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import type { AnyMock } from '../support/bun-test-types';
import { logger } from '../../src/utils/logger';

describe('Logger', () => {
  let consoleLogSpy: AnyMock;
  let consoleErrorSpy: AnyMock;
  let consoleWarnSpy: AnyMock;

  beforeEach(() => {
    // console メソッドをモック
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    // モックをリストア
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  describe('info', () => {
    it('should log info message with timestamp', () => {
      logger.info('Test info message');

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const loggedMessage = consoleLogSpy.mock.calls[0][0];
      expect(loggedMessage).toContain('[INFO]');
      expect(loggedMessage).toContain('Test info message');
    });

    it('should log info message with additional arguments', () => {
      const testObj = { key: 'value' };
      logger.info('Test message', testObj);

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Test message'),
        testObj
      );
    });

    it('should include ISO timestamp', () => {
      logger.info('Test');

      const loggedMessage = consoleLogSpy.mock.calls[0][0];
      // ISO 8601形式のタイムスタンプを含むことを確認
      expect(loggedMessage).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    });
  });

  describe('error', () => {
    it('should log error message with timestamp', () => {
      logger.error('Test error message');

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const loggedMessage = consoleErrorSpy.mock.calls[0][0];
      expect(loggedMessage).toContain('[ERROR]');
      expect(loggedMessage).toContain('Test error message');
    });

    it('should log error with error object', () => {
      const error = new Error('Test error');
      logger.error('An error occurred', error);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('An error occurred'),
        error
      );
    });
  });

  describe('warn', () => {
    it('should log warning message with timestamp', () => {
      logger.warn('Test warning message');

      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      const loggedMessage = consoleWarnSpy.mock.calls[0][0];
      expect(loggedMessage).toContain('[WARN]');
      expect(loggedMessage).toContain('Test warning message');
    });
  });

  describe('debug', () => {
    it('should log debug message with timestamp', () => {
      logger.debug('Test debug message');

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const loggedMessage = consoleLogSpy.mock.calls[0][0];
      expect(loggedMessage).toContain('[DEBUG]');
      expect(loggedMessage).toContain('Test debug message');
    });
  });
});
