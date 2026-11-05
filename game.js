import { t } from './i18n.js';
import { CODECS, description, metrics, sizeLabel, timeLabel } from './model.js';

export function gameCandidates(patterns, source) {
  if (!source) return [];
  const reference = { id: 'reference', reference: true, config: { codec: 'wav', rate: source.rate, channels: source.channels, depth: 24 } };
  const seen = new Set();
  return [reference, ...patterns].filter(pattern => {
    if (!pattern.reference && (pattern.state !== 'ready' || !pattern.blob)) return false;
    const c = pattern.config;
    // ponytail: 同じ設定と既知の可逆PCM条件だけをまとめる。非可逆圧縮の偶然の一致は判定しない。
    const key = ['flac', 'wav'].includes(c.codec) ? `pcm:${c.rate}:${c.channels}:${c.depth}` : `${c.codec}:${description(c)}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

export function shuffled(items, random = Math.random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

const playPath = 'M6 3 21 12 6 21Z', pausePath = 'M5 3h5v18H5zm9 0h5v18h-5z';
const repeatIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m17 2 4 4-4 4M21 6H7a4 4 0 0 0-4 4m4 12-4-4 4-4M3 18h14a4 4 0 0 0 4-4"/></svg>';

export class ListeningGame {
  constructor(getPlayer, getPatterns, onOpen, onClose) {
    this.getPlayer = getPlayer; this.getPatterns = getPatterns;
    this.onOpen = onOpen; this.onClose = onClose;
    this.dialog = document.getElementById('game'); this.stage = document.getElementById('game-stage');
    this.job = 0; this.active = false;
    document.getElementById('game-open').addEventListener('click', () => this.open());
    document.getElementById('game-close').addEventListener('click', () => this.close());
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
    this.dialog.addEventListener('close', () => { if (!this.dialog.open) this.close(); });
    this.stage.addEventListener('change', event => {
      if (event.target.name === 'game-include') this.stage.querySelector('#game-start').disabled = this.stage.querySelectorAll('[name="game-include"]:checked').length < 2;
      if (event.target.name === 'game-answer') { this.selected = Number(event.target.value); this.tick(); }
      if (event.target.id === 'game-seek') {
        this.seeking = false; this.player.seek(Number(event.target.value));
        if (!this.player.playing && this.player.frame < this.player.totalFrames) this.prepare();
      }
    });
    this.stage.addEventListener('input', event => {
      if (event.target.id === 'game-seek') { this.seeking = true; this.stage.querySelector('#game-elapsed').textContent = timeLabel(Number(event.target.value)); }
    });
    this.stage.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button || button.disabled) return;
      if (button.id === 'game-start') this.start([...this.stage.querySelectorAll('[name="game-include"]:checked')].map(input => Number(input.value)));
      if (button.id === 'game-answer') this.answer();
      if (button.id === 'game-next') this.next();
      if (button.id === 'game-again') this.setup();
      if (button.id === 'game-finish') this.close();
      if (button.id === 'game-retry') this.prepare();
      if (button.id === 'game-play') { if (this.player.playing) this.player.pause(); else this.player.play().catch(() => this.fail()); this.tick(); }
      if (button.id === 'game-loop') { this.player.loop = !this.player.loop; this.tick(); }
      if (button.dataset.listen) {
        this.listen = button.dataset.listen;
        if (!this.player.playing) this.prepare();
        else { this.player.select(this.listeningPattern); this.tick(); }
      }
    });
  }
  open() {
    if (this.active) return;
    const player = this.getPlayer(), patterns = this.getPatterns();
    this.pool = gameCandidates(patterns, player.source);
    if (!player.source || this.pool.length < 2) return;
    this.player = player;
    this.source = player.source;
    this.saved = { pattern: patterns.find(p => p.id === player.target.id) || null, position: player.position, loop: player.loop };
    this.omitted = patterns.filter(p => p.state === 'ready' && p.blob).length + 1 - this.pool.length;
    this.active = true;
    document.body.classList.add('cc-game-open');
    player.pause(); this.onOpen(); this.setup(); this.dialog.showModal();
  }
  close() {
    if (!this.active) return;
    this.active = false; this.job++;
    this.player.comparisonTargets = [];
    this.player.pause(); this.player.select(this.saved.pattern); this.player.seek(this.saved.position); this.player.loop = this.saved.loop;
    this.dialog.close(); document.body.classList.remove('cc-game-open');
    this.onClose(); document.getElementById('game-open').focus();
    this.pool = this.items = this.order = this.saved = this.source = this.player = null;
  }
  setup() {
    this.player.comparisonTargets = [];
    this.job++; this.player.pause(); this.phase = 'setup';
    this.round = this.score = 0; this.selected = null; this.error = ''; this.preparing = false; this.seeking = false;
    this.stage.innerHTML = `<p class="cc-game-description">${t("基準音源と生成済みのパターンから出題します。回答ごとに選択肢が減り、最後の2択で終了します。")}</p>${this.omitted ? `<p class="cc-game-description">${t("同じ設定・同じPCMのパターンは、先頭の1件だけ出題します。")}</p>` : ''}${this.choices(this.pool, true)}<button class="cc-primary cc-game-action" id="game-start">${t("はじめる")}</button>`;
  }
  start(indices) {
    const selected = new Set(indices);
    this.items = this.pool.filter((_, i) => selected.has(i));
    if (this.items.length < 2) return;
    this.order = shuffled(this.items.map((_, i) => i));
    this.phase = 'question'; this.listen = 'correct';
    return this.prepare();
  }
  get listeningPattern() {
    const pattern = this.items[this.listen === 'selected' ? this.selected : this.order[this.round]];
    return this.listen === 'reference' || pattern?.reference ? null : pattern;
  }
  async prepare() {
    const player = this.player, job = ++this.job;
    const valid = () => this.active && this.player === player && this.job === job;
    this.preparing = true; this.error = ''; this.seeking = false;
    player.pause(); player.select(this.listeningPattern);
    this.renderQuestion();
    try {
      player.ensureContext();
      if (player.frame >= player.totalFrames) player.seek(0);
      if (player.analysisChunk(player.target, player.frame, Math.min(player.rate * 0.15, player.totalFrames - player.frame))) {
        this.preparing = false; this.tick(); return;
      }
      while (player.busy) { await new Promise(resolve => setTimeout(resolve, 20)); if (!valid()) return; }
      if (!valid()) return;
      player.busy = true;
      try {
        const chunk = await player.decode(player.target, player.frame, player.revision, 4);
        if (valid() && !chunk) throw Error(t("準備を取り消しました。"));
      } finally { player.busy = false; }
      if (valid()) { this.preparing = false; this.tick(); }
    } catch { if (valid()) this.fail(); }
  }
  fail() {
    if (!this.active || !['question', 'answered'].includes(this.phase)) return;
    this.preparing = false; this.error = t("音声を準備できませんでした。もう一度試してください。"); this.tick();
  }
  answer() {
    if (this.phase !== 'question' || this.preparing || this.error || this.player.buffering || this.player.requested || !Number.isInteger(this.selected) || !this.items[this.selected] || this.order.slice(0, this.round).includes(this.selected)) return;
    this.player.pause();
    if (this.selected === this.order[this.round]) this.score++;
    const reference = this.listen === 'reference';
    this.phase = 'answered'; this.listen = 'correct';
    if (reference) return this.prepare();
    this.renderQuestion();
  }
  next() {
    if (this.phase !== 'answered') return;
    this.job++; this.player.pause(); this.selected = null; this.round++;
    if (this.round === this.order.length - 1) {
      this.player.comparisonTargets = [];
      this.phase = 'result';
      this.stage.innerHTML = `<div class="cc-game-result"><img src="./icon.svg" alt=""><h3>${t("おつかれさまでした")}</h3><p>${t("{0}問中 {1} 問正解", this.items.length - 1, `<strong>${this.score}</strong>`)}</p><div><button id="game-finish">${t("比較に戻る")}</button><button class="cc-primary" id="game-again">${t("もう一度")}</button></div></div>`;
      this.stage.querySelector('#game-again').focus(); return;
    }
    this.phase = 'question'; this.listen = 'correct'; return this.prepare();
  }
  choices(items, setup = false) {
    const removed = new Set(setup ? [] : this.order.slice(0, this.round));
    return `<fieldset class="cc-game-choices ${setup ? 'cc-game-setup' : ''}"><legend class="${setup ? '' : 'cc-sr'}">${setup ? t("出題するパターン") : t("回答の選択肢")}</legend>${items.map((p, index) => {
      if (removed.has(index)) return '';
      const bytes = p.reference ? this.source.frames * this.source.channels * 3 : p.blob.size;
      const c = p.config, bitrate = CODECS[c.codec].bits && !(c.codec === 'mp3' && c.mode === 'VBR') && c.codec !== 'g711' ? `${c.bitrate} kbps` : '';
      const detail = bitrate ? description(c).replace(bitrate, '').trim() : description(c);
      const correct = this.phase === 'answered' && index === this.order[this.round];
      return `<label class="cc-game-choice ${this.phase === 'answered' ? 'cc-game-answered' : ''} ${correct ? 'cc-game-correct' : ''}"><input type="${setup ? 'checkbox' : 'radio'}" name="${setup ? 'game-include' : 'game-answer'}" value="${index}" ${setup || this.selected === index ? 'checked' : ''} ${this.phase === 'answered' ? 'disabled' : ''}><span><span class="cc-game-name">${p.reference ? t("基準音源（PCM変換済み）") : CODECS[c.codec].name} ${bitrate}${correct ? `<small>${t("正解")}</small>` : ''}</span><span class="cc-game-detail">${detail}</span><span class="cc-game-detail">${p.reference ? t("PCM換算 ") : ''}${sizeLabel(bytes)}${t(" · 基準PCM比 ")}${metrics(bytes, this.source).ratio.toFixed(1)}%</span></span></label>`;
    }).join('')}</fieldset>`;
  }
  renderQuestion() {
    const answered = this.phase === 'answered', correct = this.items[this.order[this.round]], hit = this.selected === this.order[this.round];
    const targets = [null, correct, ...(answered && !hit ? [this.items[this.selected]] : [])]
      .map(pattern => this.player.targetFor(pattern?.reference ? null : pattern));
    this.player.comparisonTargets = targets.filter((target, index) => targets.findIndex(t => t.key === target.key) === index);
    this.stage.innerHTML = `<div class="cc-game-heading"><h3 tabindex="-1">${answered ? t("答え合わせ") : t("この音はどの設定？")}</h3><span>${this.round + 1} / ${this.items.length - 1}${t(" 問")}</span></div>
      ${answered ? `<div class="cc-game-feedback" role="status"><strong>${hit ? t("正解！") : t("正解はこちら")}</strong><small>${correct.reference ? t("基準音源（PCM変換済み）") : CODECS[correct.config.codec].name} · ${description(correct.config)}</small></div>` : ''}
      <div class="cc-game-player"><div class="cc-game-listen" role="group" aria-label="${t("試聴する音")}"><button data-listen="correct">${answered ? t("正解の音") : t("問題の音")}</button>${answered && !hit ? `<button data-listen="selected">${t("選んだ音")}</button>` : ''}<button data-listen="reference" title="${t("基準音源（PCM変換済み）")}">${t("基準音源")}</button></div>
        <div class="cc-game-controls"><button class="cc-primary cc-game-play" id="game-play" aria-label="${t("再生")}"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${playPath}"/></svg></button><span id="game-listen-title">${t("問題の音")}</span><button id="game-loop" aria-label="${t("ループ再生")}" aria-pressed="false">${repeatIcon}</button></div>
        <div class="cc-game-seek"><span id="game-elapsed">${timeLabel(this.player.position)}</span><input id="game-seek" type="range" min="0" max="${this.source.duration}" value="${this.player.position}" step="0.01" aria-label="${t("ゲームの再生位置")}"><span>${timeLabel(this.source.duration)}</span></div>
        <p id="game-status" role="status"></p><button id="game-retry" hidden>${t("再試行")}</button>
      </div>${this.choices(this.items)}<button class="cc-primary cc-game-action" id="${answered ? 'game-next' : 'game-answer'}">${answered ? this.round + 1 === this.items.length - 1 ? t("結果を見る") : t("次の問題") : t("回答する")}</button>`;
    this.tick(); this.stage.querySelector(answered ? '#game-next' : '.cc-game-heading h3').focus();
  }
  tick() {
    if (!this.active || !['question', 'answered'].includes(this.phase)) return;
    const $ = selector => this.stage.querySelector(selector), player = this.player;
    const busy = this.preparing || player.buffering || Boolean(player.requested);
    $('#game-play').disabled = this.preparing || Boolean(this.error);
    $('#game-play').setAttribute('aria-label', player.playing ? t("一時停止") : busy ? t("音声を準備中") : t("再生"));
    $('#game-play').setAttribute('aria-busy', String(busy));
    $('#game-play path').setAttribute('d', player.playing ? pausePath : playPath);
    $('#game-loop').setAttribute('aria-pressed', String(player.loop));
    $('#game-seek').disabled = this.preparing || Boolean(this.error);
    if (!this.seeking) { $('#game-elapsed').textContent = timeLabel(player.position); $('#game-seek').value = player.position; }
    $('#game-listen-title').textContent = this.listen === 'reference' ? t("基準音源") : this.phase === 'question' ? t("問題の音") : this.listen === 'selected' ? t("選んだ音") : t("正解の音");
    $('#game-status').textContent = this.error || '';
    $('#game-status').hidden = !this.error;
    $('#game-retry').hidden = !this.error;
    const answer = $('#game-answer'); if (answer) answer.disabled = this.selected === null || busy || Boolean(this.error);
    for (const button of this.stage.querySelectorAll('[data-listen]')) button.setAttribute('aria-pressed', String(button.dataset.listen === this.listen));
  }
}
