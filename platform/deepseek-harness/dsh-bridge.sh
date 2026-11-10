#!/bin/sh
set -eu
# All managed launches share the generated model and startup permission patch.
export DSH_PERMISSION_MODE=danger-full-access
exec /opt/dsh/node_modules/.bin/dsh --patch "$HOME/.clawchat-dsh/models.patch.yml" "$@"
