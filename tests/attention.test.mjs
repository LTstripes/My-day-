import assert from 'node:assert/strict';
import {test} from 'node:test';
import {attentionDate, attentionStatus} from '../web/attention.js';

const read = value => attentionDate('---\nmyday_attention: ' + value + '\n---\nПроизвольная заметка');
const date = (y, month, day, hour = 12) => new Date(y, month - 1, day, hour);

test('only an explicit and unambiguous attention property makes a date', () => {
  assert.deepEqual(read("'2028-02-29' # вернуться"), {day:'2028-02-29', value:'2028-02-29'});
  assert.equal(attentionDate('---\ndue: 2027-03-01\n---\nmyday_attention: 2027-03-01'), null);
  assert.equal(attentionDate('---\nmyday_attention: 2027-03-01\nmyday_attention: 2027-03-02\n---'), null);
  assert.equal(attentionDate('Вступление\n---\nmyday_attention: 2027-03-01\n---'), null);
  for (const value of ['2027-02-29', '2027-04-31', '2027-11-12T24:00Z', '2027-11-12T16:00',
    '2027-11-12T16:00-00:00', '2027-11-12T16:00+25:00', 'завтра', '']) {
    assert.deepEqual(read(value), {invalid:true}, value);
  }
});

test('date-only attention follows local calendar days through year changes and seven-day boundary', () => {
  const now = date(2026, 12, 30, 23);
  assert.equal(attentionStatus(read('2026-12-29'), now), 'Просрочено');
  assert.equal(attentionStatus(read('2026-12-30'), now), 'Сегодня');
  assert.equal(attentionStatus(read('2027-01-06'), now), 'Скоро');
  assert.equal(attentionStatus(read('2027-01-07'), now), null);
  assert.equal(attentionStatus(read('2027-01-07'), date(2026, 12, 31, 0)), 'Скоро');
});

test('an instant uses its offset, while today uses the device calendar', () => {
  const due = read('2026-12-31T23:30:00-04:00');
  assert.equal(due.instant, Date.parse('2027-01-01T03:30:00Z'));
  assert.equal(attentionStatus(due, new Date(due.instant)), 'Просрочено');
  const twoSecondsEarlier = new Date(due.instant - 2000);
  assert.equal(attentionStatus(due, twoSecondsEarlier), 'Сегодня');
  assert.equal(attentionStatus(read('2027-01-01T03:30:00Z'), twoSecondsEarlier), 'Сегодня');
});
