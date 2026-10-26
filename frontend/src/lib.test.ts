// Run with: npm test  (node --test, no extra deps)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addDays, dayOfMonth, fromPaise, isAmount, monthBounds, sum, toPaise, todayIn } from './lib.ts'

test('cash in hand = revenue − expenses − handovers', () => {
  const p = toPaise('4000.00') - sum([{ amount: '820.50' }, { amount: '229.50' }]) - sum([{ amount: '500' }])
  assert.equal(p, 245000)
  assert.equal(fromPaise(p), '2450.00')
  assert.equal(toPaise(undefined) - sum([{ amount: '0.10' }, { amount: '0.20' }]), -30) // no float drift
})

test('amount parsing', () => {
  assert.equal(toPaise('0.1'), 10)
  assert.equal(toPaise('-1550.50'), -155050)
  assert.ok(isAmount('99.99') && !isAmount('-1') && !isAmount('1.234') && !isAmount(''))
})

test('dates stay on the shop calendar', () => {
  // 20:00 UTC on 31 Oct is already 1 Nov in Kolkata.
  assert.equal(todayIn('Asia/Kolkata', new Date('2026-10-31T20:00:00Z')), '2026-11-01')
  assert.equal(addDays('2026-03-01', -1), '2026-02-28')
  assert.deepEqual(monthBounds('2024-02-10'), ['2024-02-01', '2024-02-29'])
  assert.equal(dayOfMonth('2026-02-10', 31), '2026-02-28') // rent due on the 31st
  assert.equal(dayOfMonth('2026-10-26', 5), '2026-10-05')
})
