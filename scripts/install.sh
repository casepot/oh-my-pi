#!/bin/sh
set -e

# OMP Coding Agent Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/casepot/oh-my-pi/main/scripts/install.sh | sh
#
# Options:
#   --source       Install via bun from the fork source checkout (installs bun if needed)
#   --binary       Always install prebuilt binary from fork releases
#   --ref <ref>    Install specific tag/commit/branch from the fork source checkout
#   -r <ref>       Shorthand for --ref

REPO="casepot/oh-my-pi"
UPSTREAM_REPO="can1357/oh-my-pi"
INSTALL_DIR="${PI_INSTALL_DIR:-$HOME/.local/bin}"
DEFAULT_REF="main"
SOURCE_DIR="${OMP_SOURCE_DIR:-${PI_SOURCE_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/omp/source/oh-my-pi}}"
MIN_BUN_VERSION="1.3.14"

# Parse arguments
MODE=""
REF=""
while [ $# -gt 0 ]; do
    case "$1" in
        --source)
            MODE="source"
            shift
            ;;
        --binary)
            MODE="binary"
            shift
            ;;
        --ref)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        --ref=*)
            REF="${1#*=}"
            if [ -z "$REF" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            shift
            ;;
        -r)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for -r"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# If a ref is provided, default to source install
if [ -n "$REF" ] && [ -z "$MODE" ]; then
    MODE="source"
fi

# Check if bun is available
has_bun() {
    command -v bun >/dev/null 2>&1
}

version_ge() {
    current="$1"
    minimum="$2"

    current_major="${current%%.*}"
    current_rest="${current#*.}"
    current_minor="${current_rest%%.*}"
    current_patch="${current_rest#*.}"
    current_patch="${current_patch%%.*}"

    minimum_major="${minimum%%.*}"
    minimum_rest="${minimum#*.}"
    minimum_minor="${minimum_rest%%.*}"
    minimum_patch="${minimum_rest#*.}"
    minimum_patch="${minimum_patch%%.*}"

    if [ "$current_major" -ne "$minimum_major" ]; then
        [ "$current_major" -gt "$minimum_major" ]
        return $?
    fi

    if [ "$current_minor" -ne "$minimum_minor" ]; then
        [ "$current_minor" -gt "$minimum_minor" ]
        return $?
    fi

    [ "$current_patch" -ge "$minimum_patch" ]
}

require_bun_version() {
    version_raw=$(bun --version 2>/dev/null || true)
    if [ -z "$version_raw" ]; then
        echo "Failed to read bun version"
        exit 1
    fi

    version_clean=${version_raw%%-*}
    if ! version_ge "$version_clean" "$MIN_BUN_VERSION"; then
        echo "Bun ${MIN_BUN_VERSION} or newer is required. Current version: ${version_clean}"
        echo "Upgrade Bun at https://bun.sh/docs/installation"
        exit 1
    fi
}

# Check if git is available
has_git() {
    command -v git >/dev/null 2>&1
}

# Install bun
install_bun() {
    echo "Installing bun..."
    if command -v bash >/dev/null 2>&1; then
        curl -fsSL https://bun.sh/install | bash
    else
        echo "bash not found; attempting install with sh..."
        curl -fsSL https://bun.sh/install | sh
    fi
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    require_bun_version
}

# Check if git-lfs is available
has_git_lfs() {
    command -v git-lfs >/dev/null 2>&1
}

# Install via fork source checkout and bun link
ensure_clean_source_checkout() {
    if [ -n "$(git -C "$SOURCE_DIR" status --porcelain)" ]; then
        echo "Source checkout has local changes: $SOURCE_DIR"
        echo "Commit or stash them before updating."
        exit 1
    fi
}

ensure_remote() {
    name="$1"
    url="$2"
    if git -C "$SOURCE_DIR" remote get-url "$name" >/dev/null 2>&1; then
        git -C "$SOURCE_DIR" remote set-url "$name" "$url"
    else
        git -C "$SOURCE_DIR" remote add "$name" "$url"
    fi
}

checkout_source_ref() {
    ref="$1"
    if git -C "$SOURCE_DIR" show-ref --verify --quiet "refs/remotes/origin/$ref"; then
        git -C "$SOURCE_DIR" checkout -B "$ref" "origin/$ref"
    else
        git -C "$SOURCE_DIR" checkout "$ref"
    fi
}

prepare_source_checkout() {
    ref="$1"
    repo_url="https://github.com/${REPO}.git"
    upstream_url="https://github.com/${UPSTREAM_REPO}.git"

    if [ -d "$SOURCE_DIR/.git" ] || [ -f "$SOURCE_DIR/.git" ]; then
        ensure_clean_source_checkout
        ensure_remote origin "$repo_url"
        ensure_remote upstream "$upstream_url"
    else
        if [ -e "$SOURCE_DIR" ] && [ -n "$(ls -A "$SOURCE_DIR" 2>/dev/null)" ]; then
            echo "Cannot install source checkout into non-empty directory: $SOURCE_DIR"
            exit 1
        fi
        mkdir -p "$(dirname "$SOURCE_DIR")"
        git clone "$repo_url" "$SOURCE_DIR"
        git -C "$SOURCE_DIR" remote add upstream "$upstream_url"
    fi

    git -C "$SOURCE_DIR" fetch --tags origin
    git -C "$SOURCE_DIR" fetch --tags upstream || true
    checkout_source_ref "$ref"

    if has_git_lfs; then
        git -C "$SOURCE_DIR" lfs pull
    fi

    if [ ! -d "$SOURCE_DIR/packages/coding-agent" ]; then
        echo "Expected package at ${SOURCE_DIR}/packages/coding-agent"
        exit 1
    fi
}

install_source_links() {
    (cd "$SOURCE_DIR" && bun install) || {
        echo "Failed to install source dependencies"
        exit 1
    }
    (cd "$SOURCE_DIR/packages/coding-agent" && bun link) || {
        echo "Failed to link coding-agent package"
        exit 1
    }
    (cd "$SOURCE_DIR/packages/ai" && bun link) || {
        echo "Failed to link ai package"
        exit 1
    }
}

install_via_bun() {
    echo "Installing via fork source checkout..."
    if ! has_git; then
        echo "git is required for source installs"
        exit 1
    fi

    ref="${REF:-$DEFAULT_REF}"
    prepare_source_checkout "$ref"
    install_source_links

    echo ""
    echo "✓ Installed omp via fork source checkout"
    echo "Source: $SOURCE_DIR"
    echo "Run 'omp' to get started!"
}

# Install binary from GitHub releases
install_binary() {
    # Detect platform
    OS="$(uname -s)"
    ARCH="$(uname -m)"

    case "$OS" in
        Linux)  PLATFORM="linux" ;;
        Darwin) PLATFORM="darwin" ;;
        *)      echo "Unsupported OS: $OS"; exit 1 ;;
    esac

    case "$ARCH" in
        x86_64|amd64)  ARCH="x64" ;;
        arm64|aarch64) ARCH="arm64" ;;
        *)             echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac

    BINARY="omp-${PLATFORM}-${ARCH}"
    # Get release tag
    if [ -n "$REF" ]; then
        echo "Fetching release $REF..."
        if RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/tags/${REF}"); then
            LATEST=$(echo "$RELEASE_JSON" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
        else
            echo "Release tag not found: $REF"
            echo "For branch/commit installs, use --source with --ref."
            exit 1
        fi
    else
        echo "Fetching latest release..."
        RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")
        LATEST=$(echo "$RELEASE_JSON" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
    fi

    if [ -z "$LATEST" ]; then
        echo "Failed to fetch release tag"
        exit 1
    fi
    echo "Using version: $LATEST"

    mkdir -p "$INSTALL_DIR"
    # Download binary
    BINARY_URL="https://github.com/${REPO}/releases/download/${LATEST}/${BINARY}"
    echo "Downloading ${BINARY}..."
    curl -fsSL "$BINARY_URL" -o "${INSTALL_DIR}/omp"
    chmod +x "${INSTALL_DIR}/omp"
    echo ""
    echo "✓ Installed omp to ${INSTALL_DIR}/omp"

    # Check if in PATH
    case ":$PATH:" in
        *":$INSTALL_DIR:"*) echo "Run 'omp' to get started!" ;;
        *) echo "Add ${INSTALL_DIR} to your PATH, then run 'omp'" ;;
    esac
}

# Main logic
case "$MODE" in
    source)
        if ! has_bun; then
            install_bun
        fi
        require_bun_version
        install_via_bun
        ;;
    binary)
        install_binary
        ;;
    *)
        # Default: use bun if available, otherwise binary
        if has_bun; then
            require_bun_version
            install_via_bun
        else
            install_binary
        fi
        ;;
esac
