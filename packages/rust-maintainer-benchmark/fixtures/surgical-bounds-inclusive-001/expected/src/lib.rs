pub fn includes_upper_bound(value: usize, upper: usize) -> bool {
	value <= upper
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn includes_the_upper_bound() {
		assert!(includes_upper_bound(10, 10));
		assert!(includes_upper_bound(9, 10));
		assert!(!includes_upper_bound(11, 10));
	}
}
