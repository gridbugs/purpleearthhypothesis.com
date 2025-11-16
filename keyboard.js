const WIDTH_PX = 689;
const HEIGHT_PX = 200;
const SEMITONE_RATIO = Math.pow(2, 1/12);
const BOTTOM_NOTE_FREQ_HZ = 32.70; // C1

function note_index_to_freq_hz(index) {
  return Math.pow(SEMITONE_RATIO, index) * BOTTOM_NOTE_FREQ_HZ;
}

class SuperSaw {
  constructor(ctx, n, detune) {
    this.ctx = ctx;
    this.detune = detune;
    this.oscillators = [];
    this.gain = ctx.createGain();
    for (let i = 0; i < n; i++) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(0, this.ctx.currentTime);
      this.oscillators.push(osc);
      osc.connect(this.gain);
    }
  }

  setFrequency(freq_hz) {
    const detune_hz = this.detune * freq_hz;
    const start_hz = freq_hz - (detune_hz / 2);
    const step_hz = detune_hz / this.oscillators.length;
    let running_freq_hz = start_hz;
    for (const osc of this.oscillators) {
      osc.frequency.setValueAtTime(running_freq_hz, this.ctx.currentTime);
      running_freq_hz += step_hz;
    }
  }

  connect(dest) {
    this.gain.connect(dest);
  }

  start() {
    for (const osc of this.oscillators) {
      osc.start();
    }
  }
}

class Synth {
  constructor() {
    this.ctx = new AudioContext();
    this.super_saw1 = new SuperSaw(this.ctx, 2, 0.01);
    this.super_saw1.gain.gain.setValueAtTime(0.125, this.ctx.currentTime);
    this.super_saw1.start();
    this.super_saw2 = new SuperSaw(this.ctx, 2, 0.01);
    this.super_saw2.gain.gain.setValueAtTime(0.125, this.ctx.currentTime);
    this.super_saw2.start();
    this.lpf = this.ctx.createBiquadFilter();
    this.lpf.type = "lowpass";
    this.lpf.frequency.setValueAtTime(0, this.ctx.currentTime);
    this.lpf.Q.setValueAtTime(5, this.ctx.currentTime);
    this.amp = this.ctx.createGain();
    this.super_saw1.connect(this.lpf);
    this.super_saw2.connect(this.lpf);
    this.lpf.connect(this.amp);
    this.amp.connect(this.ctx.destination);
  }

  playNote(index) {
    this.amp.gain.cancelScheduledValues(this.ctx.currentTime);
    this.lpf.frequency.cancelScheduledValues(this.ctx.currentTime);
    this.amp.gain.exponentialRampToValueAtTime(1, this.ctx.currentTime + 0.1);
    this.lpf.frequency.exponentialRampToValueAtTime(20000, this.ctx.currentTime + 0.1 );
    this.super_saw1.setFrequency(note_index_to_freq_hz(index));
    this.super_saw2.setFrequency(note_index_to_freq_hz(index) * 2);
  }

  release() {
    this.amp.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 10);
    this.lpf.frequency.exponentialRampToValueAtTime(1, this.ctx.currentTime + 10);
  }
}

const KEY_IDS = [
  [ "key-0" ],
  [ "key-1" ],
  [ "key-2-f", "key-2-b" ],
  [ "key-3" ],
  [ "key-4-f", "key-4-b" ],
  [ "key-5" ],
  [ "key-6" ],
  [ "key-7-f", "key-7-b" ],
  [ "key-8" ],
  [ "key-9-f", "key-9-b" ],
  [ "key-10" ],
  [ "key-11-f", "key-11-b" ],
  [ "key-12" ],
  [ "key-13" ],
  [ "key-14-f", "key-14-b" ],
  [ "key-15" ],
  [ "key-16-f", "key-16-b" ],
  [ "key-17" ],
  [ "key-18" ],
  [ "key-19-f", "key-19-b" ],
  [ "key-20" ],
  [ "key-21-f", "key-21-b" ],
  [ "key-22" ],
  [ "key-23-f", "key-23-b" ],
  [ "key-24" ],
];

class ColorMap {
  constructor(ctx) {
    this.imgd = ctx.getImageData(0, 0, WIDTH_PX, HEIGHT_PX);
  }

  indexAt(x, y) {
    if (x < 0 || y < 0 || x >= WIDTH_PX || y >= HEIGHT_PX) {
      return -1;
    }
    const i = (x + (y * WIDTH_PX)) * 4;
    if (i >= this.imgd.data.length) {
      return -1;
    } else {
      // The key index is stored in the red channel.
      const value = this.imgd.data[i];
      if (value === 0) {
        if (this.imgd.data[i + 3] === 0) {
          // The red channel can be 0 for transparent pixels.
          return -1;
        } else {
          return 0;
        }
      } else {
        return value;
      }
    }
  }
}

function load_color_map() {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH_PX;
  canvas.height = HEIGHT_PX;
  const ctx = canvas.getContext("2d");
  const image = new Image(WIDTH_PX, HEIGHT_PX);
  image.src = "assets/keyboard-color-map.png";
  return new Promise(resolve => {
    image.addEventListener("load", _ => {
      ctx.drawImage(image, 0, 0);
      resolve(new ColorMap(ctx));
    });
  });
}

function mountainsBaseBrighter() {
  return document.getElementById("mountains-base-brighter");
}

function mountainsBaseOn() {
  const element = mountainsBaseBrighter();
  element.style.transitionDuration = "0.1s";
  element.style.opacity = "1";
}
function mountainsBaseOff() {
  const element = mountainsBaseBrighter();
  element.style.transitionDuration = "10s";
  element.style.opacity = "0";
}

class Keyboard {
  constructor(color_map) {
    this.color_map = color_map;
    this.container = document.getElementById("keyboard");
    this.key_elements = KEY_IDS.map(key_ids => {
      return key_ids.map(id => {
        return document.getElementById(id);
      });
    });
    this.pressed_key_index = -1;
    this.grid_position = 0;
    this.grid_element = document.getElementById("grid");
    this.prev_frame = undefined;
    this.grid_speed = 0;
    this.synth = undefined;
  }

  getSynth() {
    if (this.synth === undefined) {
      this.synth = new Synth();
    }
    return this.synth;
  }

  getBoundingRect() {
    const bounding_rect = this.container.getClientRects()[0];
    const height = HEIGHT_PX * bounding_rect.width / WIDTH_PX;
    return { width: bounding_rect.width, height };
  }

  getKeyElements(i) {
    return this.key_elements[i];
  }

  getPressedKeyElements() {
    return this.getKeyElements(this.pressed_key_index);
  }

  registerGen(eventType, f) {
    this.container.addEventListener(eventType, (e) => {
      const bounding_rect = this.getBoundingRect();
      const x = parseInt(WIDTH_PX * e.offsetX / bounding_rect.width);
      const y = parseInt(HEIGHT_PX * e.offsetY / bounding_rect.height);
      const i = this.color_map.indexAt(x, y);
      f(i);
    });
  }

  clearHover() {
    for (let i = 0; i < KEY_IDS.length; i++) {
      for (const key_element of this.getKeyElements(i)) {
        key_element.classList.remove("hover");
      }
    }
  }

  clearPressedKey() {
    this.pressed_key_index = -1;
    for (let i = 0; i < KEY_IDS.length; i++) {
      for (const key_element of this.getKeyElements(i)) {
        key_element.style.transform = "translate(0, 0)";
        key_element.style.transitionDuration = "0.1s";
      }
    }
  }

  pressKey(i) {
    const already_pressed = this.pressed_key_index !== -1;
    this.clearPressedKey();
    if (i === -1) {
      return;
    }
    const elements = this.getKeyElements(i);
    const bounding_rect = this.getBoundingRect();
    this.pressed_key_index = i;
    for (const element of elements) {
      element.classList.remove("hover");
      element.style.transform = `translate(0, ${bounding_rect.height * 0.04}px)`;
      element.style.transitionDuration = "0s";
    }
    if (!already_pressed) {
      mountainsBaseOn();
    }
    if (this.synth === undefined) {
      // Only start this once.
      this.moveGridLoop();
    }
    this.grid_speed = 1;
    this.getSynth().playNote(this.pressed_key_index);
  }

  moveGridLoop() {
    requestIdleCallback(_ => {
      if (this.pressed_key_index === -1) {
        this.grid_speed *= 0.995;
        if (this.grid_speed < 0.2) {
          this.grid_speed = 0;
        }
      }
      const now = Date.now();
      if (this.prev_frame !== undefined) {
        const delta = now - this.prev_frame;
        this.grid_position += delta * 0.05 * Math.pow(SEMITONE_RATIO, this.pressed_key_index) * this.grid_speed;
      }
      this.grid_element.style.backgroundPositionY = `${this.grid_position}px`;
      this.prev_frame = now;
      this.moveGridLoop();
    });
  }

  registerAll() {
    this.registerGen("mousemove", (i) => {
      this.clearHover();
      if (i >= 0) {
        const elements = this.getKeyElements(i);
        for (const element of elements) {
          element.className = "hover";
        }
        if (this.pressed_key_index >= 0) {
          this.pressKey(i);
        }
      }
    });
    this.registerGen("mouseout", _ => {
      this.clearHover();
    })
    this.registerGen("mousedown", (i) => {
      this.pressKey(i);
    });
    document.addEventListener("mouseup", _ => {
      this.clearPressedKey();
      mountainsBaseOff();
      if (this.synth !== undefined) {
        this.synth.release();
      }
    });
  }
}


async function main() {
  const color_map = await load_color_map();
  const keyboard = new Keyboard(color_map);
  keyboard.registerAll();
}


main();
