#!/bin/bash
set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Print with color
print_green() {
  echo -e "${GREEN}$1${NC}"
}

print_yellow() {
  echo -e "${YELLOW}$1${NC}"
}

print_red() {
  echo -e "${RED}$1${NC}"
}

# Check if we're in the root directory of the project
if [ ! -f "package.json" ]; then
  print_red "Error: package.json not found. Please run this script from the root directory of the project."
  exit 1
fi

# Function to validate version
validate_version() {
  if [[ ! $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    print_red "Error: Version must be in the format x.y.z"
    exit 1
  fi
}

# Function to check if working directory is clean
check_git_clean() {
  if [ "$FORCE" = false ] && [ -d ".git" ] && [ -n "$(git status --porcelain)" ]; then
    print_red "Error: Working directory is not clean. Please commit or stash your changes before releasing."
    print_yellow "Or use --force to release anyway (use with caution)."
    exit 1
  elif [ "$FORCE" = true ] && [ -d ".git" ] && [ -n "$(git status --porcelain)" ]; then
    print_yellow "Warning: Working directory is not clean, but --force was used. Proceeding anyway..."
  fi
}

# Parse command line arguments
VERSION_TYPE="patch"
SKIP_TESTS=false
SKIP_GIT=false
DRY_RUN=false
FORCE=false

while [[ "$#" -gt 0 ]]; do
  case $1 in
    --major) VERSION_TYPE="major"; shift ;;
    --minor) VERSION_TYPE="minor"; shift ;;
    --patch) VERSION_TYPE="patch"; shift ;;
    --version=*) 
      CUSTOM_VERSION="${1#*=}"
      validate_version "$CUSTOM_VERSION"
      shift 
      ;;
    --skip-tests) SKIP_TESTS=true; shift ;;
    --skip-git) SKIP_GIT=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --force) FORCE=true; shift ;;
    --help)
      echo "Usage: ./release.sh [options]"
      echo ""
      echo "Options:"
      echo "  --major                Bump major version (x.0.0)"
      echo "  --minor                Bump minor version (0.x.0)"
      echo "  --patch                Bump patch version (0.0.x) [default]"
      echo "  --version=x.y.z        Set specific version"
      echo "  --skip-tests           Skip running tests"
      echo "  --skip-git             Skip git operations (tag and commit)"
      echo "  --dry-run              Run without making any changes"
      echo "  --force                Force release even with uncommitted changes (use with caution)"
      echo "  --help                 Show this help message"
      exit 0
      ;;
    *)
      print_red "Unknown parameter: $1"
      echo "Use --help for usage information"
      exit 1
      ;;
  esac
done

# Check if git is available and the directory is a git repository
if [ "$SKIP_GIT" = false ]; then
  if ! command -v git &> /dev/null; then
    print_yellow "Warning: git command not found. Git operations will be skipped."
    SKIP_GIT=true
  elif [ ! -d ".git" ]; then
    print_yellow "Warning: .git directory not found. Git operations will be skipped."
    SKIP_GIT=true
  else
    check_git_clean
  fi
fi

# Get current version from package.json
CURRENT_VERSION=$(node -p "require('./package.json').version")
print_yellow "Current version: $CURRENT_VERSION"

# Calculate new version if not specified
if [ -z "$CUSTOM_VERSION" ]; then
  if [ "$VERSION_TYPE" = "major" ]; then
    NEW_VERSION=$(node -p "const [major, minor, patch] = '${CURRENT_VERSION}'.split('.'); \`\${parseInt(major) + 1}.0.0\`")
  elif [ "$VERSION_TYPE" = "minor" ]; then
    NEW_VERSION=$(node -p "const [major, minor, patch] = '${CURRENT_VERSION}'.split('.'); \`\${major}.\${parseInt(minor) + 1}.0\`")
  else # patch
    NEW_VERSION=$(node -p "const [major, minor, patch] = '${CURRENT_VERSION}'.split('.'); \`\${major}.\${minor}.\${parseInt(patch) + 1}\`")
  fi
else
  NEW_VERSION="$CUSTOM_VERSION"
fi

print_yellow "New version will be: $NEW_VERSION"

if [ "$DRY_RUN" = true ]; then
  print_yellow "Dry run mode. No changes will be made."
  exit 0
fi

# Run tests if available and not skipped
if [ "$SKIP_TESTS" = false ] && grep -q '"test"' package.json; then
  print_yellow "Running tests..."
  npm test
  if [ $? -ne 0 ]; then
    print_red "Tests failed. Release aborted."
    exit 1
  fi
  print_green "Tests passed!"
else
  if [ "$SKIP_TESTS" = true ]; then
    print_yellow "Skipping tests as requested."
  else
    print_yellow "No test script found in package.json. Skipping tests."
  fi
fi

# Update version in package.json
print_yellow "Updating version in package.json..."
npm version $NEW_VERSION --no-git-tag-version

# Make sure the main script is executable
print_yellow "Ensuring main script is executable..."
chmod +x src/index.js

# Git operations
if [ "$SKIP_GIT" = false ]; then
  print_yellow "Committing version change..."
  git add package.json
  git commit -m "chore: bump version to $NEW_VERSION"
  
  print_yellow "Creating git tag v$NEW_VERSION..."
  git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"
  
  print_yellow "You may want to push changes with: git push && git push --tags"
fi

# Publish to npm
print_yellow "Publishing to npm..."
npm publish

print_green "✅ Successfully released version $NEW_VERSION!"
print_yellow "To install globally: npm install -g a11y-mcp"
print_yellow "To use with npx: npx a11y-mcp"
