# Overlens: one container serving the API and the web app (REQ_DEPLOY_001).
# Stage 1 builds the frontend, stage 2 builds the Go binary with that frontend embedded,
# stage 3 is a minimal distroless image that runs as a non-root user (REQ_DEPLOY_011).
#
#   docker build -t overlens --build-arg VERSION=$(make -s version) --build-arg COMMIT=$(git rev-parse --short HEAD) .
#
# Without --build-arg VERSION (CapRover builds from the files alone, with no git), the VERSION file is used (REQ_DEPLOY_010).

# --- Stage 1: frontend -------------------------------------------------------------------------
FROM node:22 AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# --- Stage 2: Go binary ------------------------------------------------------------------------
FROM golang:1.27 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# The built frontend replaces the placeholder web/dist that `go:embed` reads (web/embed.go).
COPY --from=web /src/web/dist ./web/dist
ARG VERSION=
ARG COMMIT=unknown
ARG BUILD_TIME=unknown
# modernc.org/sqlite is pure Go, so CGO is off and the binary is static (runs on distroless/static).
# The -X names are the variables in cmd/roadmap/main.go.
RUN V="${VERSION:-$(cat VERSION 2>/dev/null || echo dev)}" && CGO_ENABLED=0 go build -trimpath \
      -ldflags "-s -w -X main.version=${V} -X main.commit=${COMMIT} -X main.buildTime=${BUILD_TIME}" \
      -o /out/roadmap ./cmd/roadmap
# The final image has no shell, so the empty /data and /backups folders are made here, owned by
# the non-root user (uid 65532), and copied over. A named volume inherits this ownership.
RUN mkdir -p /rootfs/data /rootfs/backups

# --- Stage 3: runtime --------------------------------------------------------------------------
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/roadmap /app/roadmap
# No roadmap.conf in the image: the ROADMAP_* variables below carry the whole configuration, and a
# missing config file is not an error then (REQ_DEPLOY_011). Every other setting has a built-in default.
COPY --from=build --chown=65532:65532 /rootfs/data /data
COPY --from=build --chown=65532:65532 /rootfs/backups /backups

ENV ROADMAP_ENVIRONMENT=production \
    ROADMAP_PORT=8080 \
    ROADMAP_DB_PATH=/data/roadmap-database.db \
    ROADMAP_LOG_DIR=/data/logs \
    ROADMAP_BACKUP_DIR=/backups
# Not set here, so every deployment must choose them: ROADMAP_BOOTSTRAP_ADMIN_USER and
# ROADMAP_BOOTSTRAP_ADMIN_PASSWORD (or ROADMAP_BOOTSTRAP_ADMIN_PASSWORD_FILE).

VOLUME ["/data", "/backups"]
EXPOSE 8080
USER 65532:65532
WORKDIR /app
# distroless has no shell, curl or wget, so the health check is the program itself (REQ_DEPLOY_009):
# `-healthcheck` asks http://127.0.0.1:<ROADMAP_PORT>/health and exits 0 on 200, else 1. Exec form only.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["/app/roadmap", "-healthcheck"]
ENTRYPOINT ["/app/roadmap"]
