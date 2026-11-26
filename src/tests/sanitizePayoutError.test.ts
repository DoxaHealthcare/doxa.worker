import assert from 'node:assert/strict'
import test from 'node:test'

import { sanitizePayoutError } from '../utils/sanitizePayoutError.js'

test('passes through normal error text', () => {
  assert.equal(
    sanitizePayoutError(new Error('Wallet credit failed: insufficient balance')),
    'Wallet credit failed: insufficient balance'
  )
})

test('strips email addresses', () => {
  const out = sanitizePayoutError('Payout failed for doctor@example.com account')
  assert.ok(!out.includes('doctor@example.com'))
  assert.match(out, /\[email\]/)
})

test('strips long digit sequences (cards, phones, accounts)', () => {
  const out = sanitizePayoutError(
    'Transfer to 0123456789 failed; card 4111 1111 1111 1111 declined; call +234 803 123 4567'
  )
  assert.ok(!/\d{9,}/.test(out.replace(/\[number\]/g, '')))
  assert.match(out, /\[number\]/)
})

test('strips separated digit groups (phones with spaces/dashes)', () => {
  for (const input of [
    'Call doctor on 0803 123 4567 for details',
    'Reach +234-803-123-4567 or 0803.123.4567',
    'Account 1234 5678 9012 verification failed'
  ]) {
    const out = sanitizePayoutError(input)
    assert.ok(!/\d{9,}/.test(out), `leaked digits in: ${out}`)
    assert.match(out, /\[number\]/)
  }
})

test('keeps short numbers and comma-separated amounts', () => {
  const out = sanitizePayoutError('Payout of 15,000 failed with code 500 after 3 retries')
  assert.match(out, /15,000/)
  assert.match(out, /500/)
  assert.match(out, /3 retries/)
})

test('keeps short numbers like HTTP status codes', () => {
  const out = sanitizePayoutError('Upstream returned 500 after 3 retries')
  assert.match(out, /500/)
  assert.match(out, /3 retries/)
})

test('truncates long messages', () => {
  const out = sanitizePayoutError('x'.repeat(500))
  assert.ok(out.length <= 201)
  assert.ok(out.endsWith('…'))
})

test('handles non-error input', () => {
  assert.equal(sanitizePayoutError(undefined), 'unknown error')
  assert.equal(sanitizePayoutError(null), 'unknown error')
  assert.equal(sanitizePayoutError(42), '42')
})
