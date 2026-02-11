#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: nerd-art <image-path> [width] [--preview output.png] [--no-dither] [--contrast=N] [--interactive]" >&2
  echo "  --contrast=N   Adjust contrast (-1 to 1, 0=none, default 0)" >&2
  echo "  --interactive  Open interactive UI with live controls" >&2
  exit 1
}

if [[ $# -lt 1 ]]; then usage; fi

IMAGE=""
WIDTH=""
PREVIEW=""
INTERACTIVE=false
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --preview)
      shift
      [[ $# -gt 0 ]] || usage
      PREVIEW="$1"
      ;;
    --no-dither)
      EXTRA_ARGS+=("--no-dither")
      ;;
    --contrast=*)
      EXTRA_ARGS+=("$1")
      ;;
    --interactive)
      INTERACTIVE=true
      ;;
    -*)
      echo "Unknown option: $1" >&2; usage
      ;;
    *)
      if [[ -z "$IMAGE" ]]; then
        IMAGE="$1"
      elif [[ -z "$WIDTH" ]]; then
        WIDTH="$1"
      else
        echo "Unexpected argument: $1" >&2; usage
      fi
      ;;
  esac
  shift
done

[[ -n "$IMAGE" ]] || usage

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ "$INTERACTIVE" == true ]]; then
  exec electron "$SCRIPT_DIR/interactive.js" "$IMAGE"
fi

WIDTH_ARG="${WIDTH:-80}"

ART=$(electron "$SCRIPT_DIR/main.js" "$IMAGE" "$WIDTH_ARG" "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}" 2>/dev/null)

echo "$ART"

if [[ -n "$PREVIEW" ]]; then
  echo "$ART" > /tmp/_nerd_art_preview.txt
  electron "$SCRIPT_DIR/preview.js" /tmp/_nerd_art_preview.txt "$PREVIEW" 2>/dev/null
  rm -f /tmp/_nerd_art_preview.txt
  echo "[nerd-art] Preview saved to $PREVIEW" >&2
fi
