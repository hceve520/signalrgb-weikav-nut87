export function Name() { return "WEIKAV NUT87"; }
export function Version() { return "1.0.0"; }
export function VendorId() { return 0x0C45; }
export function ProductId() { return 0x880C; }
export function Publisher() { return "nut87-re"; }
export function Documentation() { return ""; }
export function Type() { return "Hid"; }
export function DeviceType() { return "keyboard"; }
export function Size() { return [19, 6]; }
export function ImageUrl() { return "https://static.driveall.cn/static/keyboards/NUT87.png"; }

// Anyone else talking to the keyboard fights us for the same HID interface.
export function ConflictingProcesses() {
	return ["Music.exe", "musicplug.exe"];
}

export function Validate(endpoint) {
	// Control interface: MI_03, usage page 0xFF68, usage 0x61.
	return endpoint.usage_page === 0xFF68 && endpoint.usage === 0x0061;
}

/* global
shutdownMode:readonly
shutdownColor:readonly
LightingMode:readonly
forcedColor:readonly
protocol:readonly
*/

export function ControllableParameters() {
	return [
		{ property: "shutdownMode", group: "lighting", label: "Shutdown Mode", description: "Sets whether the device should follow SignalRGB shutdown color, or go back to hardware lighting", type: "combobox", values: ["SignalRGB", "Hardware"], default: "Hardware" },
		{ property: "shutdownColor", group: "lighting", label: "Shutdown Color", description: "Color applied when Shutdown Mode is SignalRGB and the system or SignalRGB shuts down", min: "0", max: "360", type: "color", default: "#000000" },
		{ property: "LightingMode", group: "lighting", label: "Lighting Mode", description: "Canvas follows the active effect, Forced uses a single color", type: "combobox", values: ["Canvas", "Forced"], default: "Canvas" },
		{ property: "forcedColor", group: "lighting", label: "Forced Color", min: "0", max: "360", type: "color", default: "#009bde" },
		{
			property: "protocol", group: "performance", label: "Data Channel",
			description: "Realtime streams frames over HID command 0x32 (~250 fps, RAM only). Stored table uses command 0x24 (~2 fps, writes flash) - use it only if realtime glitches.",
			type: "combobox", values: ["Realtime", "Stored table"], default: "Realtime",
		},
	];
}

export function Initialize() {
	NUT87.Initialize();
}

export function Render() {
	NUT87.Render();
}

export function Shutdown(SystemSuspending) {
	if (SystemSuspending) {
		// Sleep / shutdown: always go dark, whatever the user configured.
		NUT87.Shutdown("#000000");
		return;
	}
	/* eslint-disable-next-line no-undef */
	if (shutdownMode === "SignalRGB") {
		/* eslint-disable-next-line no-undef */
		NUT87.Shutdown(shutdownColor);
	} else {
		// "Hardware": hand the keyboard back to its own firmware.
		NUT87.RestoreHardwareLighting();
	}
}

/**
 * WEIKAV NUT87 (VID 0x0C45 / PID 0x880C, Sonix).
 *
 * Control interface MI_03, usage page 0xFF68, usage 0x61, 65-byte output
 * reports (report id 0 + 64 byte payload).
 *
 * Realtime channel (what the vendor's Music.exe uses, recovered from
 * musicplug.exe at 0x409537):
 *
 *   packet: AA 32 <size> <addrLo> <addrHi> 00 00 00 <data[56]>
 *   frame : N x [ledId, r, g, b] followed by the marker AA 55
 *
 * Every packet is applied immediately, so a frame only costs ceil(len/56)
 * writes (~0.5 ms each) - measured 250+ frames/s on hardware.
 *
 * Stored channel (command 0x24) writes the 512-byte LED table to flash and
 * needs ~40 ms per packet; kept only as a fallback.
 */
export class NUT87_Device_Protocol {
	constructor() {
		this.Config = {
			DeviceName: "WEIKAV NUT87",
			DeviceEndpoint: [{ interface: 3, usage: 0x0061, usage_page: 0xFF68, collection: 0x0000 }],
		};
		this.writeLength = 65;
		this.lastKeepAlive = 0;
		this.lastMode = 0;
		this.lastForcedRgb = "";
		this.ledIds = [];
	}

	Initialize() {
		/* eslint-disable no-undef */
		const info = device.getDeviceInfo() || {};
		device.log(`NUT87 detected: ${info.product || "unknown product"}`);
		device.setName(this.Config.DeviceName);
		device.setSize([19, 6]);

		try {
			const hidInfo = device.getHidInfo ? device.getHidInfo() : null;
			if (hidInfo && hidInfo.writeLength) this.writeLength = hidInfo.writeLength;
			device.log(`NUT87 writeLength = ${this.writeLength}`);
		} catch (error) {
			device.log(`NUT87 getHidInfo failed: ${error}`);
		}
		/* eslint-enable no-undef */

		this.ledIds = NUT87_LAYOUT.ledIds.slice();
		device.setControllableLeds(NUT87_LAYOUT.names, NUT87_LAYOUT.positions);
		this.detectEndpoint();

		// Custom mode so the stored table is the base layer; streamed frames
		// overlay it and the keyboard falls back to it when SignalRGB stops.
		this.lastMode = 128;
		this.sendEffect(128, [255, 255, 255], 6, 3, 1);
		this.lastKeepAlive = Date.now();
	}

	detectEndpoint() {
		/* eslint-disable no-undef */
		const wanted = this.Config.DeviceEndpoint[0];
		for (const current of device.getHidEndpoints()) {
			if (
				current.usage_page === wanted.usage_page &&
				current.usage === wanted.usage &&
				current.collection === wanted.collection
			) {
				device.set_endpoint(current.interface, current.usage, current.usage_page, current.collection);
				device.log(`Using endpoint interface ${current.interface} (usage page 0x${current.usage_page.toString(16)})`);
				return;
			}
		}
		device.log("NUT87 control endpoint not found, falling back to interface 3");
		device.set_endpoint(3, 0x0061, 0xFF68, 0x0000);
		/* eslint-enable no-undef */
	}

	/** Push one 64-byte payload; the engine wants the report id in front. */
	writePayload(pkt) {
		/* eslint-disable no-undef */
		if (this.writeLength > 64) {
			device.write([0x00].concat(pkt), this.writeLength);
		} else {
			device.write(pkt, this.writeLength);
		}
		/* eslint-enable no-undef */
	}

	/** Generic 0xAA packet with the standard 8-byte header. */
	packet(cmd, size, addr, data, last) {
		const pkt = new Array(64).fill(0);
		pkt[0] = 0xAA;
		pkt[1] = cmd;
		pkt[2] = size;
		pkt[3] = addr & 0xFF;
		pkt[4] = (addr >> 8) & 0xFF;
		pkt[6] = last ? 1 : 0;
		for (let i = 0; i < size; i++) pkt[8 + i] = data[i] & 0xFF;
		return pkt;
	}

	/** Chunked write for the stored-table path (0x24). */
	writeChunked(cmd, data, packetDelay) {
		const chunk = 56;
		const total = Math.max(1, Math.ceil(data.length / chunk));
		for (let i = 0; i < total; i++) {
			const addr = i * chunk;
			const last = i === total - 1;
			const size = last ? data.length - addr : chunk;
			const part = [];
			for (let k = 0; k < size; k++) part[k] = data[addr + k];
			this.writePayload(this.packet(cmd, size, addr, part, last));
			if (packetDelay) {
				/* eslint-disable-next-line no-undef */
				device.pause(packetDelay);
			}
		}
	}

	sendEffect(mode, rgb, brightness, speed, direction) {
		const data = new Array(16).fill(0);
		data[0] = mode;
		data[1] = rgb[0]; data[2] = rgb[1]; data[3] = rgb[2];
		data[4] = 255;
		data[9] = brightness;
		data[10] = speed;
		data[11] = direction;
		data[14] = 0xAA;
		data[15] = 0x55;
		this.writeChunked(0x23, data, 0);
	}

	/** True when the fast per-key channel is selected. */
	get realtime() {
		/* eslint-disable-next-line no-undef */
		return protocol !== "Stored table";
	}

	grabColors(overrideColor) {
		const positions = NUT87_LAYOUT.positions;
		const colors = [];
		for (let i = 0; i < positions.length; i++) {
			if (overrideColor) {
				colors.push(hexToRgb(overrideColor));
			} else if (LightingMode === "Forced") {
				colors.push(hexToRgb(forcedColor));
			} else {
				/* eslint-disable-next-line no-undef */
				colors.push(device.color(positions[i][0], positions[i][1]));
			}
		}
		return colors;
	}

	/**
	 * Realtime frame: [ledId, r, g, b] per key + the AA 55 marker.
	 * 87 keys => 350 bytes => 7 packets.
	 */
	sendRealtime(colors) {
		const buf = [];
		for (let i = 0; i < this.ledIds.length; i++) {
			const c = colors[i] || [0, 0, 0];
			buf.push(this.ledIds[i] & 0xFF, c[0] & 0xFF, c[1] & 0xFF, c[2] & 0xFF);
		}
		buf.push(0xAA, 0x55);

		const chunk = 56;
		const total = Math.ceil(buf.length / chunk);
		for (let i = 0; i < total; i++) {
			const addr = i * chunk;
			const size = Math.min(chunk, buf.length - addr);
			const pkt = new Array(64).fill(0);
			pkt[0] = 0xAA;
			pkt[1] = 0x32;
			pkt[2] = size;
			pkt[3] = addr & 0xFF;
			pkt[4] = (addr >> 8) & 0xFF;
			for (let k = 0; k < size; k++) pkt[8 + k] = buf[addr + k];
			this.writePayload(pkt);
		}
	}

	/** Fallback: 512-byte stored table, 128 x [ledId, r, g, b]. */
	sendTable(colors) {
		const table = new Array(512).fill(0);
		for (let led = 0; led < 128; led++) table[led * 4] = led;
		for (let i = 0; i < this.ledIds.length; i++) {
			const led = this.ledIds[i];
			const c = colors[i] || [0, 0, 0];
			table[led * 4 + 1] = c[0] & 0xFF;
			table[led * 4 + 2] = c[1] & 0xFF;
			table[led * 4 + 3] = c[2] & 0xFF;
		}
		this.writeChunked(0x24, table, 40);
	}

	Render() {
		const now = Date.now();

		if (this.forced()) {
			// A single colour: mode 1 "static" is both simpler and brighter
			// than the realtime overlay - it is full 8-bit (verified on
			// hardware: #123456 reads back as 17,51,85) and holds the colour
			// without being refreshed, so one packet is enough.
			const rgb = hexToRgb(forcedColor);
			const key = rgb.join(",");
			if (key !== this.lastForcedRgb) {
				this.lastForcedRgb = key;
				this.lastMode = 1;
				this.sendEffect(1, rgb, 6, 3, 1);
			}
			return;
		}

		// Canvas: the stored table is the base layer, streamed frames overlay it.
		if (this.lastMode !== 128 || now - this.lastKeepAlive > 3000) {
			this.lastKeepAlive = now;
			this.lastMode = 128;
			this.sendEffect(128, [255, 255, 255], 6, 3, 1);
		}

		const colors = this.grabColors();
		if (this.realtime) {
			this.sendRealtime(colors);
		} else if (now - (this.lastTableAt || 0) > 450) {
			this.lastTableAt = now;
			this.sendTable(colors);
		}
	}

	/** True when the plugin should render one flat colour. */
	forced() {
		/* eslint-disable-next-line no-undef */
		return LightingMode === "Forced";
	}

	/**
	 * Hand the keyboard back to its own firmware ("Shutdown Mode = Hardware").
	 *
	 * Doing nothing is NOT enough: Initialize wrote mode 128 (custom) to flash,
	 * so the device would stay parked on the stale per-key table left by the
	 * official web driver. Verified on hardware that SET_LED_EFFECT survives the
	 * plugin exiting, so we explicitly switch to a firmware animation instead.
	 *
	 * Mode 9 is the built-in "rainbow" effect - a sane, self-running default
	 * that needs no host. It also overwrites the overlay on screen immediately.
	 */
	RestoreHardwareLighting() {
		// Wipe the transient overlay so no stale frame lingers on top.
		this.sendRealtime(new Array(this.ledIds.length).fill([0, 0, 0]));
		this.lastMode = HARDWARE_MODE;
		this.lastForcedRgb = "";
		this.sendEffect(HARDWARE_MODE, [255, 255, 255], 6, 3, 1);
	}

	Shutdown(color) {
		const rgb = hexToRgb(color || "#000000");
		const solid = new Array(this.ledIds.length).fill(rgb);

		// Two realtime frames make the change instant (Render has stopped by
		// now), but 0x32 is only a transient overlay that decays after ~1-2 s,
		// so it cannot hold the colour on its own.
		for (let i = 0; i < 2; i++) this.sendRealtime(solid);

		// Mode 1 = "static" is the mode that actually uses the effect colour
		// (custom mode 128 ignores it and shows the stored table instead).
		// Verified on hardware: #123456 reads back as (17,51,85) and survives.
		this.lastMode = 1;
		this.lastForcedRgb = "";
		this.sendEffect(1, rgb, 6, 3, 1);
	}
}

/**
 * Firmware effect used when Shutdown Mode = "Hardware".
 * 9 = the built-in rainbow animation (see tools/nut87.py MODE list); any
 * non-custom mode works, this one is just a good self-running default.
 */
const HARDWARE_MODE = 9;

const NUT87_LAYOUT = {	ledIds: [
		0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 99, 100, 102,
		16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 92, 103, 104, 105,
		32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 60, 106, 107, 108,
		48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 76,
		64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 90,
		80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91,
	],
	names: [
		"Esc", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12", "Print Screen", "Scroll Lock", "Pause",
		"`", "1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-", "=", "Backspace", "Insert", "Home", "Page Up",
		"Tab", "Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P", "[", "]", "\\", "Delete", "End", "Page Down",
		"Caps Lock", "A", "S", "D", "F", "G", "H", "J", "K", "L", ";", "'", "Enter",
		"Left Shift", "Z", "X", "C", "V", "B", "N", "M", ",", ".", "/", "Right Shift", "Up Arrow",
		"Left Ctrl", "Win", "Left Alt", "Space", "Right Alt", "Fn", "Menu", "Right Ctrl", "Left Arrow", "Down Arrow", "Right Arrow",
	],
	positions: [
		[0, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6.5, 0], [7.5, 0], [8.5, 0], [9.5, 0], [11, 0], [12, 0], [13, 0], [14, 0], [15.25, 0], [16.25, 0], [17.25, 0],
		[0.5, 1], [1.5, 1], [2.5, 1], [3.5, 1], [4.5, 1], [5.5, 1], [6.5, 1], [7.5, 1], [8.5, 1], [9.5, 1], [10.5, 1], [11.5, 1], [12.5, 1], [14, 1], [15.25, 1], [16.25, 1], [17.25, 1],
		[0.75, 2], [1.75, 2], [2.75, 2], [3.75, 2], [4.75, 2], [5.75, 2], [6.75, 2], [7.75, 2], [8.75, 2], [9.75, 2], [10.75, 2], [11.75, 2], [12.75, 2], [14.1, 2], [15.25, 2], [16.25, 2], [17.25, 2],
		[0.875, 3], [1.875, 3], [2.875, 3], [3.875, 3], [4.875, 3], [5.875, 3], [6.875, 3], [7.875, 3], [8.875, 3], [9.875, 3], [10.875, 3], [11.875, 3], [13.875, 3],
		[1.125, 4], [2.75, 4], [3.75, 4], [4.75, 4], [5.75, 4], [6.75, 4], [7.75, 4], [8.75, 4], [9.75, 4], [10.75, 4], [11.75, 4], [13.625, 4], [15.25, 4],
		[0.625, 5], [1.875, 5], [3.125, 5], [6.875, 5], [10.625, 5], [11.875, 5], [13.125, 5], [14.375, 5], [15.25, 5], [16.25, 5], [17.25, 5],
	],
};

const NUT87 = new NUT87_Device_Protocol();

function hexToRgb(hex) {
	const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
	if (!result) return [0, 0, 0];
	return [parseInt(result[1], 16), parseInt(result[2], 16), parseInt(result[3], 16)];
}
