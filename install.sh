#!/usr/bin/env bash
# Install the Amp plugins in this repo as system plugins.
#
#   ./install.sh                  symlink every plugin in plugins/
#   ./install.sh auto-answer      symlink one plugin
#   ./install.sh --copy [name…]   copy instead of symlinking (if Amp doesn't follow symlinks)
#   ./install.sh --uninstall [name…]
#
# Installs into $XDG_CONFIG_HOME/amp/plugins (default ~/.config/amp/plugins), where the Amp CLI,
# TUI and `amp --no-tui` runners load system plugins. AMP_PLUGINS_DIR overrides the target.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${AMP_PLUGINS_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/amp/plugins}"
mode=link
names=()

for arg in "$@"; do
	case "$arg" in
		--copy) mode=copy ;;
		--uninstall) mode=uninstall ;;
		-h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		-*) echo "unknown option: $arg" >&2; exit 2 ;;
		*) names+=("$arg") ;;
	esac
done

if [ ${#names[@]} -eq 0 ]; then
	for dir in "$repo"/plugins/*/; do names+=("$(basename "$dir")"); done
fi

mkdir -p "$target"

for name in "${names[@]}"; do
	src="$repo/plugins/$name"
	dest="$target/$name"
	if [ ! -f "$src/index.ts" ]; then
		echo "no plugin named '$name' (expected $src/index.ts)" >&2
		exit 1
	fi

	if [ -L "$dest" ]; then
		rm "$dest"
	elif [ -e "$dest" ]; then
		if [ "$mode" = link ]; then
			echo "$dest exists and is not a symlink; remove it or use --copy" >&2
			exit 1
		fi
		rm -rf "$dest"
	fi

	case "$mode" in
		link)
			ln -s "$src" "$dest"
			echo "linked $dest -> $src"
			;;
		copy)
			mkdir -p "$dest"
			(cd "$src" && tar --exclude=./node_modules --exclude=./test -cf - .) | (cd "$dest" && tar -xf -)
			echo "copied $src to $dest (re-run after every pull)"
			;;
		uninstall)
			echo "removed $dest"
			;;
	esac
done

if [ "$mode" != uninstall ]; then
	echo 'Now restart your runner (amp --no-tui), or run "plugins: reload" in an Amp TUI.'
	echo 'Check with: amp plugins list'
fi
