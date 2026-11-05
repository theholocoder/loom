// Package mcp is Loom's own MCP server, which agents run over stdio as
// `loom-bridge mcp`: newline-delimited JSON-RPC 2.0, as MCP's stdio transport
// is. Its one tool, link_merge_request, does nothing itself: Loom sees the
// agent call it, as it sees every tool call, and links the Merge request the
// call names to the Session once it has checked it on the Forge.
package mcp

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// LinkMergeRequest is the tool's name; agents prefix it with the server's
// (`loom`), as OpenCode does: `loom_link_merge_request`.
const LinkMergeRequest = "link_merge_request"

// The MCP version answered when the client asks for none.
const defaultProtocolVersion = "2025-06-18"

type message struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

var tools = []map[string]any{{
	"name":  LinkMergeRequest,
	"title": "Link Merge request",
	"description": "Link a Merge request (a pull request on GitHub) to this Loom Session, so Loom shows it and watches it. " +
		"Call it after opening a Merge request whose source branch isn't this Session's current branch, or when Loom hasn't linked it: " +
		"Loom links the open Merge request on the current branch by itself after each turn. Give its number, or its URL.",
	"inputSchema": map[string]any{
		"type": "object",
		"properties": map[string]any{
			"number": map[string]any{"type": "integer", "description": "The Merge request's number on the Forge (12 for !12 or #12)."},
			"url":    map[string]any{"type": "string", "description": "The Merge request's page on the Forge, if no number is given."},
		},
	},
}}

// Serve answers MCP requests read from r on w until r ends, returning nil
// then; version is the Client's.
func Serve(r io.Reader, w io.Writer, version string) error {
	out := json.NewEncoder(w)
	reader := bufio.NewReader(r)
	for {
		line, err := reader.ReadBytes('\n')
		if len(strings.TrimSpace(string(line))) > 0 {
			if writeErr := handle(out, line, version); writeErr != nil {
				return writeErr
			}
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func handle(out *json.Encoder, line []byte, version string) error {
	var m message
	if err := json.Unmarshal(line, &m); err != nil {
		return out.Encode(map[string]any{"jsonrpc": "2.0", "id": nil, "error": rpcError{-32700, "parse error"}})
	}
	// A notification (no id) is never answered.
	if len(m.ID) == 0 || string(m.ID) == "null" {
		return nil
	}
	reply := func(result any, err *rpcError) error {
		response := map[string]any{"jsonrpc": "2.0", "id": m.ID}
		if err != nil {
			response["error"] = err
		} else {
			response["result"] = result
		}
		return out.Encode(response)
	}
	switch m.Method {
	case "initialize":
		var params struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(m.Params, &params)
		agreed := params.ProtocolVersion
		if agreed == "" {
			agreed = defaultProtocolVersion
		}
		return reply(map[string]any{
			"protocolVersion": agreed,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "loom", "version": version},
		}, nil)
	case "ping":
		return reply(map[string]any{}, nil)
	case "tools/list":
		return reply(map[string]any{"tools": tools}, nil)
	case "tools/call":
		var params struct {
			Name      string `json:"name"`
			Arguments struct {
				Number json.Number `json:"number"`
				URL    string      `json:"url"`
			} `json:"arguments"`
		}
		if err := json.Unmarshal(m.Params, &params); err != nil {
			return reply(nil, &rpcError{-32602, "invalid params: " + err.Error()})
		}
		if params.Name != LinkMergeRequest {
			return reply(nil, &rpcError{-32602, fmt.Sprintf("unknown tool %q", params.Name)})
		}
		which := params.Arguments.Number.String()
		if which == "" {
			which = strings.TrimSpace(params.Arguments.URL)
		}
		if which == "" {
			return reply(toolResult("Give the Merge request's number, or its URL.", true), nil)
		}
		return reply(toolResult(fmt.Sprintf("Loom links Merge request %s to this Session once it has found it open on the Forge.", which), false), nil)
	default:
		return reply(nil, &rpcError{-32601, fmt.Sprintf("method not found: %s", m.Method)})
	}
}

func toolResult(text string, isError bool) map[string]any {
	return map[string]any{"content": []map[string]any{{"type": "text", "text": text}}, "isError": isError}
}
