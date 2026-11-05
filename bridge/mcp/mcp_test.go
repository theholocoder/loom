package mcp_test

import (
	"bufio"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/theholocoder/loom/bridge/mcp"
)

type client struct {
	t     *testing.T
	in    *io.PipeWriter
	lines chan map[string]any
	done  chan error
}

func start(t *testing.T) *client {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	c := &client{t: t, in: inW, lines: make(chan map[string]any, 16), done: make(chan error, 1)}
	go func() {
		err := mcp.Serve(inR, outW, "1.2.3")
		outW.Close()
		c.done <- err
	}()
	go func() {
		scanner := bufio.NewScanner(outR)
		for scanner.Scan() {
			var message map[string]any
			if err := json.Unmarshal(scanner.Bytes(), &message); err != nil {
				t.Errorf("server wrote something other than JSON: %q", scanner.Text())
				continue
			}
			c.lines <- message
		}
		close(c.lines)
	}()
	t.Cleanup(func() { inW.Close() })
	return c
}

func (c *client) send(message map[string]any) {
	c.t.Helper()
	message["jsonrpc"] = "2.0"
	data, _ := json.Marshal(message)
	if _, err := c.in.Write(append(data, '\n')); err != nil {
		c.t.Fatal(err)
	}
}

func (c *client) receive() map[string]any {
	c.t.Helper()
	select {
	case message := <-c.lines:
		return message
	case <-time.After(5 * time.Second):
		c.t.Fatal("no reply")
		return nil
	}
}

func TestInitializeAgreesOnTheClientsProtocolVersionAndOffersTools(t *testing.T) {
	c := start(t)
	c.send(map[string]any{"id": 1, "method": "initialize", "params": map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "opencode"}}})

	reply := c.receive()
	result := reply["result"].(map[string]any)
	if result["protocolVersion"] != "2025-06-18" {
		t.Errorf("protocolVersion = %v", result["protocolVersion"])
	}
	if _, ok := result["capabilities"].(map[string]any)["tools"]; !ok {
		t.Errorf("capabilities = %v, want tools", result["capabilities"])
	}
	if info := result["serverInfo"].(map[string]any); info["name"] != "loom" || info["version"] != "1.2.3" {
		t.Errorf("serverInfo = %v", info)
	}
}

func TestListsTheLinkMergeRequestTool(t *testing.T) {
	c := start(t)
	c.send(map[string]any{"method": "notifications/initialized"})
	c.send(map[string]any{"id": "list", "method": "tools/list"})

	reply := c.receive()
	if reply["id"] != "list" {
		t.Fatalf("a notification was answered, or the id is wrong: %v", reply)
	}
	tools := reply["result"].(map[string]any)["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("tools = %v", tools)
	}
	tool := tools[0].(map[string]any)
	if tool["name"] != "link_merge_request" {
		t.Errorf("name = %v", tool["name"])
	}
	properties := tool["inputSchema"].(map[string]any)["properties"].(map[string]any)
	if _, ok := properties["number"]; !ok {
		t.Errorf("inputSchema properties = %v, want number", properties)
	}
}

func TestCallingTheToolSaysLoomLinksIt(t *testing.T) {
	c := start(t)
	c.send(map[string]any{"id": 2, "method": "tools/call", "params": map[string]any{"name": "link_merge_request", "arguments": map[string]any{"number": 12}}})

	result := c.receive()["result"].(map[string]any)
	if result["isError"] == true {
		t.Fatalf("isError: %v", result)
	}
	text := result["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(text, "12") {
		t.Errorf("text = %q, want it to name the Merge request", text)
	}
}

func TestCallingWithoutANumberOrURLIsAToolError(t *testing.T) {
	c := start(t)
	c.send(map[string]any{"id": 3, "method": "tools/call", "params": map[string]any{"name": "link_merge_request", "arguments": map[string]any{}}})

	result := c.receive()["result"].(map[string]any)
	if result["isError"] != true {
		t.Errorf("result = %v, want isError", result)
	}
}

func TestUnknownToolsAndMethodsAreErrors(t *testing.T) {
	c := start(t)
	c.send(map[string]any{"id": 4, "method": "tools/call", "params": map[string]any{"name": "rm_rf", "arguments": map[string]any{}}})
	if reply := c.receive(); reply["error"] == nil {
		t.Errorf("unknown tool: %v, want an error", reply)
	}
	c.send(map[string]any{"id": 5, "method": "resources/list"})
	if reply := c.receive(); reply["error"].(map[string]any)["code"] != float64(-32601) {
		t.Errorf("unknown method: %v, want -32601", reply)
	}
	c.send(map[string]any{"id": 6, "method": "ping"})
	if reply := c.receive(); reply["result"] == nil {
		t.Errorf("ping: %v, want a result", reply)
	}
}

func TestEndsCleanlyWhenStdinCloses(t *testing.T) {
	c := start(t)
	c.in.Close()
	select {
	case err := <-c.done:
		if err != nil {
			t.Errorf("Serve = %v, want nil", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("did not end")
	}
}
