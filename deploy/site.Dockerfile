# The built site, dist/, as an image of its files alone: the server pulls it
# and unpacks /site (deploy/pien-deploy). CI lays out its context
# (.github/workflows/build.yml) in two parts, each a layer of its own:
#
#   blocks/site/vm/fs/   the machine's file blocks, named by their content and
#                        most of the size, which most commits leave as they are
#   rest/site/           everything else
#
# Every file and directory dated 1970, so that a layer whose files did not
# change is the same layer, and neither pushed nor pulled again.

FROM scratch
COPY blocks/ /
COPY rest/ /
