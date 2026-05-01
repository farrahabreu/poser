'use strict';

const db = require('../db/db');

// Keyword tiers — add terms as needed
const TIER_HIGH = new Set([
  'kill yourself', 'kys', 'go die', 'i will kill', 'bomb threat',
  'shoot you', 'rape', 'doxx', 'i know where you live',
]);

const TIER_MED = new Set([
  'worthless', 'subhuman', 'slur1', 'slur2', // expand with actual terms
  'you should die', 'hate you', 'harass',
]);

const TIER_LOW = new Set([
  'spam', 'buy now', 'click here', 'follow for follow', 'f4f', 'promo',
]);

function scan(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  const matches = [];
  for (const term of TIER_HIGH) {
    if (lower.includes(term)) matches.push({ term, severity: 'high' });
  }
  for (const term of TIER_MED) {
    if (lower.includes(term)) matches.push({ term, severity: 'medium' });
  }
  for (const term of TIER_LOW) {
    if (lower.includes(term)) matches.push({ term, severity: 'low' });
  }
  return matches;
}

function getTopSeverity(matches) {
  if (matches.some(m => m.severity === 'high'))   return 'high';
  if (matches.some(m => m.severity === 'medium')) return 'medium';
  if (matches.some(m => m.severity === 'low'))    return 'low';
  return null;
}

/**
 * Run inside an existing transaction. Inserts a moderation_flag if needed.
 * Returns { flagged: bool, severity: string|null }
 */
function checkAndFlag(targetType, targetId, text) {
  const matches = scan(text);
  if (!matches.length) return { flagged: false, severity: null };

  const severity = getTopSeverity(matches);
  db.prepare(
    `INSERT INTO moderation_flags (target_type, target_id, flag_source, severity, matched_terms)
     VALUES (?, ?, 'ai_keyword', ?, ?)`
  ).run(targetType, targetId, severity, JSON.stringify(matches.map(m => m.term)));

  return { flagged: true, severity };
}

module.exports = { checkAndFlag, scan };
