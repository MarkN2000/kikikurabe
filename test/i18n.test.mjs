import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { english, resolveLanguage } from '../i18n.js';

test('優先順位と地域指定を扱い、未対応言語は英語へ戻す', () => {
  for (const [languages, expected] of [
    [['ja-JP', 'en-US'], 'ja'], [['en-GB', 'ja'], 'en'], [['fr', 'JA-jp', 'en'], 'ja'],
    [['de', 'en-US', 'ja'], 'en'], [['zh-CN'], 'en'], [[], 'en'], [[undefined], 'en'],
  ]) assert.equal(resolveLanguage(languages), expected);
});

test('画面・Workerの全翻訳キーと静的HTMLに英訳を揃える', async () => {
  for (const name of ['app.js', 'audio.js', 'model.js', 'game.js', 'graph.js', 'analysis.js', 'analysis-cache.js', 'pcm-cache.js', 'pcm-worker.js']) {
    const script = await readFile(new URL(`../${name}`, import.meta.url), 'utf8');
    for (const match of script.matchAll(/\bt\("([^"]+)"/g)) assert.ok(english[match[1]], `${name}: ${match[1]}`);
  }
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  for (const match of html.matchAll(/<[^>]+\sdata-i18n(?=[\s>])[^>]*>([^<>]*[ぁ-んァ-ヶ一-龯][^<>]*)</g)) {
    assert.ok(english[match[1]], `HTML: ${match[1]}`);
  }
  for (const match of html.matchAll(/(?:aria-label|title|content)="([^"]*[ぁ-んァ-ヶ一-龯][^"]*)"/g)) {
    assert.ok(english[match[1]], `HTML属性: ${match[1]}`);
  }
});

test('日本語・英語でページ、設定説明、エラー、クイズを同じ言語にする', () => {
  const run = (language, worker = false) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    ${worker ? 'globalThis.WorkerGlobalScope = class {};' : 'globalThis.window = {};'}
    Object.defineProperty(globalThis, 'navigator', { value: { languages: ${JSON.stringify([language])} }, configurable: true });
    const { t, locale, localizePage } = await import('./i18n.js');
    const { description, defaults, validateConfig } = await import('./model.js');
    const { ListeningGame } = await import('./game.js');
    const text = { textContent: '比較パターン' };
    const meta = { content: '' };
    const label = { value: '再生', getAttribute() { return this.value; }, setAttribute(name, value) { this.value = value; } };
    const root = { documentElement: {}, querySelector: () => meta,
      querySelectorAll: selector => selector === '[data-i18n]' ? [text] : selector === '[data-i18n-aria-label]' ? [label] : [] };
    localizePage(root);
    let error; try { validateConfig({}, { rate: 48000 }); } catch (e) { error = e.message; }
    const source = { rate: 48000, channels: 2, frames: 48000, duration: 1 };
    const choices = ListeningGame.prototype.choices.call({ source, phase: 'setup' }, [{ reference: true, config: defaults('wav', source) }], true);
    console.log(JSON.stringify({ locale, lang: root.documentElement.lang, text: text.textContent, label: label.value, og: meta.content,
      description: description(defaults('vorbis', source)), error, choices, score: t('{0}問中 {1} 問正解', 4, 3),
      literal: t('音声処理に失敗しました。{0}', '$& {0}'), unknown: t('unknown') }));
  `], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }));
  for (const worker of [false, true]) {
    const en = run('en-US', worker), ja = run('ja-JP', worker);
    assert.equal(en.lang, 'en'); assert.equal(en.text, 'Comparison variants'); assert.equal(en.label, 'Play');
    assert.equal(en.og, 'en_US'); assert.equal(en.score, '3 correct out of 4');
    assert.equal(en.error, 'Invalid audio settings.'); assert.match(en.description, /Quality 4/);
    assert.doesNotMatch(en.choices, /[ぁ-んァ-ヶ一-龯]/); assert.match(en.choices, /Reference/);
    assert.equal(en.literal, 'Audio processing failed. $& {0}'); assert.equal(en.unknown, 'unknown');
    assert.equal(ja.lang, 'ja'); assert.equal(ja.text, '比較パターン'); assert.equal(ja.label, '再生');
    assert.equal(ja.score, '4問中 3 問正解'); assert.match(ja.choices, /基準音源/);
  }
});
