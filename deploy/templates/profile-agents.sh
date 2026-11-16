# Vision and Tom (written by install.sh): the agents' tools for the agent users.
case "$(id -un 2>/dev/null)" in
  vt-a-*) PATH="@OPT@/agents/node_modules/.bin:@OPT@/node/bin:$PATH"; export PATH ;;
esac
