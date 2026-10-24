# SignalRGB WEIKAV NUT87 Plugin

SignalRGB HID plugin for the **WEIKAV NUT87** keyboard (Sonix `0C45:880C`) —
full per-key canvas lighting at up to **250+ fps**, reverse-engineered from the
vendor's own `Music.exe` instead of relying on the official web driver.

[![Add To SignalRGB](https://marketplace.signalrgb.com/resources/add-extension-256.png "Add to My SignalRGB Installation")](https://srgbmods.net/s?p=addon/install?url=https://github.com/hceve520/signalrgb-weikav-nut87)

## Why this exists

The NUT87 has no official SignalRGB support, and the vendor's web driver
(`weikav.driveall.cn`) only offers a slow per-key "stored table" write: 512 bytes
in 10 packets that need **~40 ms each** (~2 fps, and it writes flash).

`Music.exe` (the vendor's music-visualiser companion) does not use that path. Its
real-time channel is **HID command `0x32`**, recovered by disassembling
`musicplug.exe`:

```
packet: AA 32 <size> <addrLo> <addrHi> 00 00 00 <data[56]>
frame : N x [ledId, r, g, b] + marker AA 55     (87 keys -> 350 B -> 7 packets)
```

Each packet applies immediately, so a frame costs ~4 ms and the keyboard keeps
up with **250+ frames/s** (measured). RAM only — no flash wear.

## Install

1. Click **Add To SignalRGB**, or
2. Manual: copy `WEIKAV_NUT87.js` to
   `%userprofile%\Documents\WhirlwindFX\Plugins\` and restart SignalRGB.

One-click URL:

```
https://srgbmods.net/s?p=addon/install?url=https://github.com/hceve520/signalrgb-weikav-nut87
```

## Supported

| Name | VID | PID | Interface | Usage Page | LEDs |
| --- | --- | --- | --- | --- | --- |
| WEIKAV NUT87 (wired) | `0x0C45` | `0x880C` | MI_03 | `0xFF68` / `0x61` | 87 |
| WEIKAV NUT87 (2.4G dongle) | `0x0C45` | `0xFEF9` | MI_03 | `0xFF60` / `0x61` | 87 |

Both transports speak the same protocol; only the PID and the control
interface's usage page change, so the plugin matches either one.

> **2.4G notes**
> * The dongle is silent while the keyboard sleeps — writes are dropped without
>   an error. The plugin re-sends the mode every 3 s, so the first packet after
>   a keypress re-initialises the link.
> * Press a key once after switching to 2.4G (or after the keyboard sleeps) if
>   lighting looks frozen.
> * The vendor's web driver needs a fresh WebHID permission prompt for the 2.4G
>   PID, so it appears as "no device" until you re-authorise it. This plugin does
>   not use WebHID and is unaffected.


## Settings

| Parameter | Default | Description |
| --- | --- | --- |
| `Lighting Mode` | Canvas | `Canvas` follows the effect, `Forced` uses one colour |
| `Forced Color` | `#009bde` | Colour used when Lighting Mode = Forced |
| `Shutdown Mode` | **Hardware** | `Hardware` hands the keyboard back to its firmware, `SignalRGB` applies the shutdown colour |
| `Shutdown Color` | `#000000` | Only used when Shutdown Mode = SignalRGB (sleep always goes dark) |
| `Data Channel` | Realtime | `Realtime` = command `0x32`; `Stored table` = command `0x24` fallback (~2 fps) |

`Forced` mode uses the firmware's static effect, which is full 8-bit. The
real-time channel itself is **7-bit** (the firmware stores `value >> 1`), so
per-key canvas animations top out at about half the maximum brightness. This is
a firmware property — the vendor's own visualiser has the same limit.

## Requirements

- Windows + [SignalRGB](https://www.signalrgb.com/)
- Keyboard connected **wired** (the vendor disables all drivers in Bluetooth mode)
- Do **not** run the official web driver or `Music.exe` at the same time — they
  fight for the same HID interface and the transfers corrupt each other

## Protocol reference

| cmd | Name | Notes |
| --- | --- | --- |
| `0x10` | GET_DEVICE_INFO | 48 bytes |
| `0x13` | GET_LED_EFFECT | mode, rgb, driver, colourMode, brightness, speed, direction |
| `0x14` | GET_CUSTOM_LED_DATA | 512 B stored table |
| `0x23` | SET_LED_EFFECT | mode `1` = static (uses colour), `128` = custom (stored table) |
| `0x24` | SET_CUSTOM_LED_DATA | 512 B table, ~40 ms/packet |
| `0x32` | real-time frame | the fast path, see above |
| `0x33` | GET_ALL_LIGHTS_RGB | 512 B live read-back |

Everything was recovered from the web driver bundle
(`https://weikav.driveall.cn/assets/layout-classic-*.js`) and from static
analysis of `musicplug.exe` (`CHFDMusicDlg::UpdateMusicEffect` at VA `0x409537`),
then verified on real hardware.

## License

MIT

## Disclaimer

HID lighting plugins can brick firmware if the protocol is misused. Use at your
own risk. Not affiliated with WEIKAV, Sonix, or SignalRGB.
