// The Go side of bench/measure.sh.
//
// One binary, one case per run, so each measurement is a fresh process and
// nothing is measured on a warm JIT.  The bodies mirror bench/l0p/*.l0p exactly:
// same loop, same call, same recursion, so the ratio means something.

package main

import (
	"fmt"
	"os"
	"time"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: l0pbench CASE")
		os.Exit(2)
	}
		// The elapsed milliseconds, not the result: the harness compares timings,
	// and printing the result instead would leave it reading this program's
	// answer as a duration.
	var start = time.Now()
	var out int
	switch os.Args[1] {
	case "loop":
		out = loop(1000000)
	case "add":
		out = add(1000000)
	case "call":
		out = calls(1000000)
	case "fib":
		out = fib(27)
	case "walk":
		out = walk(1000000)
	default:
		fmt.Fprintf(os.Stderr, "unknown case %q\n", os.Args[1])
		os.Exit(2)
	}
	fmt.Printf("%.1f %d\n", float64(time.Since(start).Microseconds())/1000, out)
}

func loop(n int) int {
	i := 0
	for i < n {
		i = i + 1
	}
	return i
}

func add(n int) int {
	i, t := 0, 0
	for i < n {
		t = t + i
		i = i + 1
	}
	return t
}

func g(n int) int { return n + 1 }

func calls(n int) int {
	t, i := 0, 0
	for i < n {
		t = g(t)
		i = i + 1
	}
	return t
}

func fib(n int) int {
	if n < 2 {
		return n
	}
	return fib(n-1) + fib(n-2)
}

func walk(n int) int {
	t := 0
	for i := 0; i < n; i++ {
		t += i
	}
	return t
}
