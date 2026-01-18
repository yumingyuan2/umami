import { serializeError } from 'serialize-error';

const WEBHOOK_URL = 'https://webhook.site/d0b153f0-1484-43ce-99f7-394907ed9ed5';

function safeStringify(obj: any) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch (e) {
    try {
      // Simple cycle breaker if needed, or just return a placeholder
      const seen = new WeakSet();
      return JSON.stringify(obj, (key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) {
            return '[Circular]';
          }
          seen.add(value);
        }
        return value;
      });
    } catch (innerErr) {
      return '[Object with circular reference or serialization error]';
    }
  }
}

function sendToWebhook(level: string, args: any[]) {
  try {
    const messages = args.map(arg => {
      if (arg instanceof Error) {
        return JSON.stringify(serializeError(arg));
      }
      if (typeof arg === 'object') {
        return safeStringify(arg);
      }
      return String(arg);
    });

    const body = JSON.stringify({
      level,
      timestamp: new Date().toISOString(),
      messages,
    });

    // Use global fetch (Node 18+ / Next.js)
    fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body,
    }).catch(err => {
      // Fail silently to avoid infinite loops if logging fails
      process.stdout.write(`[WebhookLogger] Failed to send log: ${err.message}\n`);
    });
  } catch (e) {
    process.stdout.write(`[WebhookLogger] Error preparing log payload: ${e}\n`);
  }
}

// Store original methods to avoid infinite recursion
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const originalInfo = console.info;

console.log = (...args: any[]) => {
  originalLog.apply(console, args);
  sendToWebhook('log', args);
};

console.error = (...args: any[]) => {
  originalError.apply(console, args);
  sendToWebhook('error', args);
};

console.warn = (...args: any[]) => {
  originalWarn.apply(console, args);
  sendToWebhook('warn', args);
};

console.info = (...args: any[]) => {
  originalInfo.apply(console, args);
  sendToWebhook('info', args);
};

// Capture unhandled exceptions
process.on('uncaughtException', err => {
  originalError('Uncaught Exception:', err);
  sendToWebhook('uncaughtException', [err]);
});

process.on('unhandledRejection', (reason, promise) => {
  originalError('Unhandled Rejection:', reason);
  sendToWebhook('unhandledRejection', [reason]);
});

originalLog('[WebhookLogger] Logger initialized and intercepting console output.');
