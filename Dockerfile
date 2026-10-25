# Single container: the Go API also serves the built PWA (STATIC_DIR).
# Used for hosts that run one service, e.g. Render (see render.yaml).
# docker-compose.yml uses backend/ and frontend/ Dockerfiles instead.
FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build

FROM golang:1.26-alpine AS api
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /api .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=api /api /api
COPY --from=web /web/dist /web
ENV STATIC_DIR=/web
EXPOSE 8080
ENTRYPOINT ["/api"]
