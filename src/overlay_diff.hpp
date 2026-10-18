// Turn an overlayfs upper layer into a list of Changes. Linux only.
//
// The upper layer holds exactly what a command touched: new and copied-up
// files, whiteouts (char device 0/0) for deletions, and opaque directories
// (xattr trusted.overlay.opaque=y) for directories that were replaced. Only
// those paths are compared against the lower layer, so the cost scales with
// what the command did, not with the size of the filesystem.
#pragma once
#include <string>
#include <vector>

#include "changes.hpp"

// upper: the overlay's upperdir
// lower: the original directory (the overlay's lowerdir)
// shown: the path users know this tree by, used in the reported paths (e.g. "/" or "/home")
// Only upper and lower are read, never the mounted overlay, so diffing while the
// command runs doesn't show up among the files the command was seen reading.
// Moves are not paired here; call pair_moves() on the combined result of every layer.
std::vector<Change> diff_overlay(const std::string &upper, const std::string &lower, const std::string &shown);

// A single file that was bind-mounted (overlayfs needs directories): compare
// the original against the scratch copy the command wrote to.
bool diff_file(const std::string &original, const std::string &copy, const std::string &shown, Change &out);

std::string file_digest(const std::string &path);  // "" if unreadable
