import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const html = await readFile(new URL("index.html", root), "utf8");
const manifest = JSON.parse(
  await readFile(new URL("manifest.webmanifest", root), "utf8"),
);
const serviceWorker = await readFile(new URL("sw.js", root), "utf8");
const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

assert.ok(inlineScript, "the inline application script must exist");
const testableScript = inlineScript.split("// ── 起動 ──")[0];

function createRuntime(AudioContextClass) {
  const window = {};
  if (AudioContextClass) window.AudioContext = AudioContextClass;

  const context = vm.createContext({
    clearTimeout,
    console,
    setTimeout,
    window,
  });
  new vm.Script(testableScript).runInContext(context);
  vm.runInContext(
    `
      drawSounding = () => {};
      clearAudioError = () => { globalThis.audioError = ""; };
      showAudioError = (message) => { globalThis.audioError = message; };
    `,
    context,
  );
  return context;
}

function relativeLuminance(hex) {
  const channels = hex
    .match(/../g)
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground, background) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test("application and service-worker scripts parse", () => {
  assert.doesNotThrow(() => new vm.Script(testableScript));
  assert.doesNotThrow(() => new vm.Script(serviceWorker));
});

test("frequency calculation follows A4", () => {
  const context = createRuntime();
  assert.equal(vm.runInContext("calcFreq('A', 4, 440)", context), 440);
  assert.ok(
    Math.abs(vm.runInContext("calcFreq('E', 2, 440)", context) - 82.4069) < 0.001,
  );
});

test("failed audio startup leaves the UI stopped and reports the problem", async () => {
  const context = createRuntime();
  await vm.runInContext("clickFork()", context);

  assert.equal(vm.runInContext("S.playing", context), null);
  assert.equal(vm.runInContext("pendingPlayingId", context), null);
  assert.match(context.audioError, /音を再生できません/);
});

test("successful audio startup publishes the playing state", async () => {
  class FakeAudioParam {
    value = 0;
    cancelScheduledValues() {}
    linearRampToValueAtTime(value) { this.value = value; }
    setTargetAtTime(value) { this.value = value; }
    setValueAtTime(value) { this.value = value; }
  }

  class FakeOscillator {
    frequency = new FakeAudioParam();
    connect() {}
    disconnect() {}
    start() { this.started = true; }
    stop() {}
  }

  class FakeGain {
    gain = new FakeAudioParam();
    connect() {}
    disconnect() {}
  }

  class FakeAudioContext {
    currentTime = 0;
    destination = {};
    state = "running";
    createGain() { return new FakeGain(); }
    createOscillator() { return new FakeOscillator(); }
  }

  const context = createRuntime(FakeAudioContext);
  await vm.runInContext("clickFork()", context);

  assert.equal(vm.runInContext("S.playing.id", context), "A4_fork");
  assert.equal(vm.runInContext("osc.frequency.value", context), 440);
  assert.equal(context.audioError, "");
});

test("release copy and controls expose the current action", () => {
  assert.match(html, /id="audioError"[^>]*role="alert"/);
  assert.match(html, /on \? '音叉を止める' : '音叉を鳴らす'/);
  assert.match(html, /onclick="setMode\('fork'\)"/);
  assert.doesNotMatch(html, /function toggleFork/);
});

test("small controls and muted copy meet release minimums", () => {
  const colors = Object.fromEntries(
    [...html.matchAll(/--(bg|card|dim):\s*#([0-9a-f]{6})/gi)].map((match) => [
      match[1],
      match[2],
    ]),
  );

  assert.ok(contrastRatio(colors.dim, colors.bg) >= 4.5);
  assert.ok(contrastRatio(colors.dim, colors.card) >= 4.5);
  assert.match(html, /\.sb\s*\{[\s\S]*?width:\s*44px;\s*height:\s*44px;/);
  assert.equal(html.match(/\.mode-btn\s*\{/g)?.length, 1);
});

test("the installed app supports either device orientation", () => {
  assert.equal(manifest.orientation, "any");
});

test("public metadata assets exist", async () => {
  const assetPaths = [
    "icons/favicon-32.png",
    "icons/apple-touch-icon.png",
    "icons/icon-192.png",
    "icons/icon-512.png",
    "icons/og.jpg",
  ];

  await Promise.all(assetPaths.map((path) => access(new URL(path, root))));
});
