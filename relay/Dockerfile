# The relay as one static binary in an otherwise empty image. Its DNS
# upstream speaks TLS with built-in roots, so the image needs no files.
#
#   docker build -t relay relay/
#   docker run -v ./relay.toml:/etc/relay.toml:ro -p 127.0.0.1:8095:8095 relay
#
# relay.toml then listens on 0.0.0.0:8095. ICMP uses ping sockets, which
# containers allow every group by default; the relay runs as nobody.

FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
# The dependencies first, built for a stand-in of the relay: a layer of their
# own, which a build cache keeps until Cargo.lock changes.
RUN mkdir src && echo 'fn main() {}' > src/main.rs && touch src/lib.rs \
	&& cargo build --release --locked && rm -r src
COPY src src
# Then the relay itself, dated after its stand-in so that cargo builds it anew.
RUN touch src/main.rs src/lib.rs && cargo build --release --locked && strip target/release/relay

FROM scratch
COPY --from=build /src/target/release/relay /relay
USER 65534:65534
ENTRYPOINT ["/relay", "/etc/relay.toml"]
