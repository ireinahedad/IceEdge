// Test env defaults. Set BEFORE any app module is imported (auth.service throws
// at import time if JWT_SECRET is missing). No real secrets — CI/local only.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ||= 'test-secret-not-for-production';
process.env.EMAIL_VERIFICATION_DISABLED ||= 'true';
