# press in an image of its own: Node, its few packages, its sources. Built
# from the repository's root, which later parts of press read from too:
#
#   docker build -f press/Dockerfile -t press .
#   docker run --env-file press.env -v ./data:/data -v ./secrets:/run/secrets:ro press
#
# `docker exec <container> press enroll` prints the code for a first passkey.

FROM node:26-alpine
WORKDIR /app/press
COPY press/package.json press/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY press/src src
RUN printf '#!/bin/sh\nexec node /app/press/src/main.ts "$@"\n' > /usr/local/bin/press && chmod 755 /usr/local/bin/press
USER node
EXPOSE 8096
CMD ["press"]
