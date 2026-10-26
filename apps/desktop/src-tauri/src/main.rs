// sessionpipe for the desktop: see lib.rs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    sessionpipe_desktop::run();
}
