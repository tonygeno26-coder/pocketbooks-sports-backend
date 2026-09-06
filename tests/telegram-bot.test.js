'use strict';

const fs = require('fs');
const path = require('path');

describe('telegram-bot survivor wiring', function() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'telegram-bot.js'), 'utf8');
  const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

  test('exports webhook + notification hooks', function() {
    const bot = require('../telegram-bot');
    expect(typeof bot.handleWebhook).toBe('function');
    expect(typeof bot.handleLinkStatus).toBe('function');
    expect(typeof bot.notifySurvivorPick).toBe('function');
    expect(typeof bot.notifySurvivorGrade).toBe('function');
    expect(typeof bot.startTelegramBot).toBe('function');
  });

  test('registers survivor telegram webhook route', function() {
    expect(indexSrc).toMatch(/\/api\/survivor\/telegram\/webhook/);
    expect(indexSrc).toMatch(/telegramBot\.handleWebhook/);
    expect(indexSrc).toMatch(/telegramBot\.notifySurvivorPick/);
    expect(indexSrc).toMatch(/telegramBot\.notifySurvivorGrade/);
    expect(indexSrc).toMatch(/telegramBot\.startTelegramBot/);
  });

  test('command handlers and copy match product spec', function() {
    expect(src).toMatch(/\/pick/);
    expect(src).toMatch(/\/standings/);
    expect(src).toContain("Welcome to PocketBooks Sports! 🏈 You'll receive survivor pool pick reminders and results here.");
    expect(src).toContain('pick locked in —');
    expect(src).toContain('picks open — deadline Sunday 1PM ET at');
    expect(src).toContain('pocketbookssports.com');
    expect(src).toMatch(/won — you are still alive/);
    expect(src).toMatch(/lost — you have been eliminated/);
  });

  test('does not hardcode a live bot token', function() {
    expect(src).not.toMatch(/\d{8,}:AA[A-Za-z0-9_-]{20,}/);
  });

  test('handleWebhook rejects unauthorized bodies', function() {
    const bot = require('../telegram-bot');
    const prev = process.env.TELEGRAM_WEBHOOK_SECRET;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    let status = null;
    let body = null;
    const res = {
      status: function(code) { status = code; return this; },
      json: function(payload) { body = payload; return this; }
    };
    bot.handleWebhook({ headers: {}, body: {} }, res);
    expect(status).toBe(401);
    expect(body).toEqual({ ok: false, error: 'unauthorized' });
    if (prev == null) delete process.env.TELEGRAM_WEBHOOK_SECRET;
    else process.env.TELEGRAM_WEBHOOK_SECRET = prev;
  });
});
