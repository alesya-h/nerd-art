# nerd-art

An image-to-Unicode-art converter that transforms raster images into text artwork using glyphs from the [Nerd Fonts](https://www.nerdfonts.com/) character set. Instead of basic ASCII characters like `#` and `.`, it uses block elements, braille patterns, sextants, wedges, and other geometric Unicode symbols to produce high-fidelity monochrome representations suitable for any Nerd Font-enabled terminal.

**Try it in your browser:** <https://alesya-h.github.io/nerd-art/>

## How It Works

The core algorithm is a **sub-cell glyph matching** system with optional **Floyd-Steinberg dithering**:

1. **Glyph measurement** -- Each candidate Unicode glyph is rendered onto a canvas and subdivided into a grid of sub-cells (default 4x8 = 32). The average ink density of each sub-cell is recorded as a fingerprint.
2. **Image sampling** -- The source image is sampled at sub-cell resolution. For each character position, the corresponding region is compared against all glyph fingerprints using Mean Squared Error.
3. **Best match selection** -- The glyph with the lowest MSE is chosen for each position.
4. **Dithering** (optional) -- Floyd-Steinberg error diffusion distributes quantization error to neighboring cells, improving tonal accuracy.

## Glyph Groups

The converter draws from a rich catalog of Unicode characters, organized into togglable groups (in interactive/web mode):

| Group | Description | Default |
|---|---|---|
| Blocks | Full/fractional/half blocks | On |
| Quadrants | 2x2 quadrant blocks | On |
| Diagonals | `╱ ╲ ╳` | On |
| Braille | All 256 braille patterns (width warning) | Off |
| Sextants | 2x3 sextant characters | On |
| Wedges | Diagonal fill/wedge characters | On |
| ASCII Punctuation | `! @ # $ %` etc. | On |
| ASCII Letters | A-Z, a-z | Off |
| Legacy Block Combos | Combined block elements | On |
| Shades | `░ ▒ ▓` | Off |

## Usage

### Web Mode

Open <https://alesya-h.github.io/nerd-art/> in a browser, or open `index.html` locally. Drag and drop an image or use the file picker. No installation required.

Provides real-time controls for width, resolution, contrast, lightness, dithering, inversion, and glyph group selection.

### CLI Mode

Requires [Electron](https://www.electronjs.org/) installed globally and a [Nerd Font](https://www.nerdfonts.com/) (SauceCodePro Nerd Font Mono) installed on the system.

```
./nerd-art.sh <image-path> [width] [--no-dither] [--contrast=N] [--preview output.png] [--interactive]
```

**Options:**

| Flag | Description |
|---|---|
| `width` | Output width in columns (default: 80) |
| `--no-dither` | Disable Floyd-Steinberg dithering |
| `--contrast=N` | Adjust contrast, -1 to 1 (default: 0) |
| `--preview output.png` | Save a PNG rendering of the output |
| `--interactive` | Open the interactive GUI with live controls |

**Examples:**

```bash
# Basic conversion, 80 columns wide
./nerd-art.sh photo.png

# 120 columns, no dithering
./nerd-art.sh photo.png 120 --no-dither

# With contrast boost and PNG preview
./nerd-art.sh photo.png 100 --contrast=0.3 --preview output.png

# Interactive GUI
./nerd-art.sh photo.png --interactive
```

## Installation

```bash
# 1. Install Electron
npm install -g electron

# 2. Install a Nerd Font (e.g., SauceCodePro Nerd Font Mono)
#    https://www.nerdfonts.com/font-downloads

# 3. Clone and run
git clone <repo-url>
cd nerd-art
./nerd-art.sh image.png
```

No `npm install` step is needed -- the project has zero runtime dependencies.

## License

MIT -- see [LICENSE](LICENSE) for details.
