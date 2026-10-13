const BUTTONS = {
    UP: 0x0001, DOWN: 0x0002, LEFT: 0x0004, RIGHT: 0x0008,
    START: 0x0010, LEFT_SHOULDER: 0x0100, RIGHT_SHOULDER: 0x0200,
    A: 0x1000, B: 0x2000, X: 0x4000,
};
const HOLD_MS = 900;
const REPEAT_DELAY_MS = 350;
const REPEAT_MS = 140;
const STICK_DEADZONE = 14000;

// Native controller state is interpreted here so hold/repeat behavior can be tested
// without a physical controller or a foreground Windows game.
class ControllerInput {
    constructor() {
        this.controllers = new Map();
    }

    reset() {
        this.controllers.clear();
    }

    update(sample, context, now = Date.now()) {
        if (!sample || !Number.isInteger(sample.index) || sample.index < 0 || sample.index > 3) return [];
        if (!sample.connected) {
            this.controllers.delete(sample.index);
            return [];
        }
        if (!Number.isInteger(sample.buttons) || sample.buttons < 0 || sample.buttons > 0xffff) return [];
        const previous = this.controllers.get(sample.index) || {
            buttons: sample.buttons, holdAt: null, consumed: false, direction: null, repeatAt: 0, leftTrigger: false, rightTrigger: false,
        };
        const state = { ...previous, buttons: sample.buttons };
        const overlayActive = context.overlayVisible && context.overlayFocused;
        const eligible = sample.gameForeground === true || overlayActive;
        const actions = [];
        const startPressed = Boolean(sample.buttons & BUTTONS.START);
        if (!eligible) {
            state.holdAt = null;
            state.consumed = startPressed;
            state.direction = null;
        } else if (!startPressed) {
            state.holdAt = null;
            state.consumed = false;
        } else if (!state.consumed) {
            if (state.holdAt === null) state.holdAt = now;
            if (now - state.holdAt >= HOLD_MS) {
                actions.push('toggle');
                state.consumed = true;
            }
        }

        if (overlayActive && !actions.includes('toggle')) {
            const pressed = sample.buttons & ~previous.buttons;
            if (pressed & BUTTONS.B) actions.push('back');
            else if (pressed & BUTTONS.A) actions.push('play');
            else if (pressed & BUTTONS.X) actions.push('clear-filters');
            else if (pressed & BUTTONS.LEFT_SHOULDER) actions.push('previous-year');
            else if (pressed & BUTTONS.RIGHT_SHOULDER) actions.push('next-year');
            const leftTrigger = Number(sample.leftTrigger) >= 180;
            const rightTrigger = Number(sample.rightTrigger) >= 180;
            if (leftTrigger && !previous.leftTrigger) actions.push('page-up');
            if (rightTrigger && !previous.rightTrigger) actions.push('page-down');
            state.leftTrigger = leftTrigger;
            state.rightTrigger = rightTrigger;

            let direction = null;
            if (sample.buttons & BUTTONS.UP) direction = 'up';
            else if (sample.buttons & BUTTONS.DOWN) direction = 'down';
            else if (sample.buttons & BUTTONS.LEFT) direction = 'left';
            else if (sample.buttons & BUTTONS.RIGHT) direction = 'right';
            else {
                const x = Number(sample.leftX) || 0;
                const y = Number(sample.leftY) || 0;
                if (Math.max(Math.abs(x), Math.abs(y)) >= STICK_DEADZONE) {
                    direction = Math.abs(x) > Math.abs(y) ? (x > 0 ? 'right' : 'left') : (y > 0 ? 'up' : 'down');
                }
            }
            if (direction && (direction !== previous.direction || now >= previous.repeatAt)) {
                actions.push(direction);
                state.repeatAt = now + (direction !== previous.direction ? REPEAT_DELAY_MS : REPEAT_MS);
            }
            state.direction = direction;
        } else {
            state.direction = null;
            state.leftTrigger = Number(sample.leftTrigger) >= 180;
            state.rightTrigger = Number(sample.rightTrigger) >= 180;
        }
        this.controllers.set(sample.index, state);
        return actions;
    }
}

module.exports = { ControllerInput, BUTTONS, HOLD_MS };
