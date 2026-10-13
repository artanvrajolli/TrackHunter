const test = require('node:test');
const assert = require('node:assert/strict');
const { ControllerInput, BUTTONS, HOLD_MS } = require('../controller');

const game = { overlayVisible: false, overlayFocused: false };
const overlay = { overlayVisible: true, overlayFocused: true };
const sample = (buttons = 0, options = {}) => ({ index: 0, connected: true, buttons, gameForeground: true, leftX: 0, leftY: 0, ...options });

test('Start needs a deliberate hold, toggles once, and rearms only after release', () => {
    const input = new ControllerInput();
    assert.deepEqual(input.update(sample(BUTTONS.START), game, 0), []);
    assert.deepEqual(input.update(sample(BUTTONS.START), game, HOLD_MS - 1), []);
    assert.deepEqual(input.update(sample(BUTTONS.START), game, HOLD_MS), ['toggle']);
    assert.deepEqual(input.update(sample(BUTTONS.START), overlay, HOLD_MS * 3), []);
    input.update(sample(), overlay, 3000);
    input.update(sample(BUTTONS.START), overlay, 3100);
    assert.deepEqual(input.update(sample(BUTTONS.START), overlay, 3100 + HOLD_MS), ['toggle']);
});

test('a short press, focus loss, or disconnect cancels the hold', () => {
    const input = new ControllerInput();
    input.update(sample(BUTTONS.START), game, 0);
    input.update(sample(), game, 500);
    assert.deepEqual(input.update(sample(), game, 1000), []);
    input.update(sample(BUTTONS.START), game, 1100);
    input.update(sample(BUTTONS.START, { gameForeground: false }), game, 1200);
    assert.deepEqual(input.update(sample(BUTTONS.START), game, 3000), []);
    input.update(sample(), game, 3100);
    input.update(sample(BUTTONS.START), game, 3200);
    input.update(sample(0, { connected: false }), game, 3300);
    assert.deepEqual(input.update(sample(BUTTONS.START), game, 4200), []);
});

test('game buttons never navigate or play while the picker is hidden or unfocused', () => {
    const input = new ControllerInput();
    input.update(sample(), game, 0);
    assert.deepEqual(input.update(sample(BUTTONS.A | BUTTONS.DOWN), game, 50), []);
    assert.deepEqual(input.update(sample(BUTTONS.B), { overlayVisible: true, overlayFocused: false }, 100), []);
});

test('A and B are edge-triggered, and buttons held before opening cannot launch a map', () => {
    const input = new ControllerInput();
    input.update(sample(BUTTONS.A), game, 0);
    assert.deepEqual(input.update(sample(BUTTONS.A), overlay, 50), []);
    input.update(sample(), overlay, 100);
    assert.deepEqual(input.update(sample(BUTTONS.A), overlay, 150), ['play']);
    assert.deepEqual(input.update(sample(BUTTONS.A), overlay, 200), []);
    assert.deepEqual(input.update(sample(BUTTONS.B), overlay, 250), ['back']);
});

test('direction repeat starts immediately, waits, then repeats at a controlled speed', () => {
    const input = new ControllerInput();
    assert.deepEqual(input.update(sample(BUTTONS.RIGHT), overlay, 0), ['right']);
    assert.deepEqual(input.update(sample(BUTTONS.RIGHT), overlay, 349), []);
    assert.deepEqual(input.update(sample(BUTTONS.RIGHT), overlay, 350), ['right']);
    assert.deepEqual(input.update(sample(BUTTONS.RIGHT), overlay, 489), []);
    assert.deepEqual(input.update(sample(BUTTONS.RIGHT), overlay, 490), ['right']);
    assert.deepEqual(input.update(sample(BUTTONS.DOWN), overlay, 500), ['down']);
});

test('left stick drift is ignored and the strongest axis determines direction', () => {
    const input = new ControllerInput();
    assert.deepEqual(input.update(sample(0, { leftX: 4000, leftY: -3000 }), overlay, 0), []);
    assert.deepEqual(input.update(sample(0, { leftX: 16000, leftY: -25000 }), overlay, 50), ['down']);
    assert.deepEqual(input.update(sample(0, { leftX: -28000, leftY: 16000 }), overlay, 100), ['left']);
});

test('shoulders switch years and triggers move one page per press', () => {
    const input = new ControllerInput();
    input.update(sample(), overlay, 0);
    assert.deepEqual(input.update(sample(BUTTONS.LEFT_SHOULDER), overlay, 50), ['previous-year']);
    assert.deepEqual(input.update(sample(BUTTONS.RIGHT_SHOULDER), overlay, 100), ['next-year']);
    assert.deepEqual(input.update(sample(0, { rightTrigger: 200 }), overlay, 150), ['page-down']);
    assert.deepEqual(input.update(sample(0, { rightTrigger: 255 }), overlay, 200), []);
    assert.deepEqual(input.update(sample(0, { leftTrigger: 200 }), overlay, 250), ['page-up']);
});

test('controllers cannot combine their hold time or navigate from malformed samples', () => {
    const input = new ControllerInput();
    input.update(sample(BUTTONS.START), game, 0);
    assert.deepEqual(input.update(sample(BUTTONS.START, { index: 1 }), game, 800), []);
    assert.deepEqual(input.update(sample(BUTTONS.START, { index: 1 }), game, 1000), []);
    assert.deepEqual(input.update(sample(BUTTONS.START, { index: 4 }), game, 2000), []);
    assert.deepEqual(input.update(sample(-1), overlay, 2000), []);
    assert.deepEqual(input.update(null, overlay, 2000), []);
});
