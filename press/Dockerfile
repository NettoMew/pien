# press in an image of its own: Node, git for the writing's history, its few
# packages, and its sources with the four of the site's it renders with, laid
# out as in the repository. Built from the repository's root (.dockerignore
# lets only these in):
#
#   docker build -f press/Dockerfile -t press .
#   docker run --env-file press.env -v ./data:/data -v ./secrets:/run/secrets:ro press
#
# `docker exec <container> press enroll` prints the code for a first passkey.

FROM node:26-alpine
RUN apk add --no-cache git
WORKDIR /app
# At the root, so that the site's files below find them too.
COPY press/package.json press/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY press/src press/src
COPY scripts/lib/blog.ts scripts/lib/content.ts scripts/lib/
COPY image/image.config.ts image/
COPY src/theme.ts src/
RUN printf '#!/bin/sh\nexec node /app/press/src/main.ts "$@"\n' > /usr/local/bin/press && chmod 755 /usr/local/bin/press
USER node
EXPOSE 8096
CMD ["press"]
