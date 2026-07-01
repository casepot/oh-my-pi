// Benchmark fixture rationale: deliberately restrictive Vec-specific API for a
// slice migration task.
pub fn total_label_len(labels: &Vec<String>) -> usize {
	labels.iter().map(|label| label.len()).sum()
}

pub fn default_total_label_len() -> usize {
	let labels = [String::from("red"), String::from("green"), String::from("blue")];
	total_label_len(&labels.to_vec())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn totals_explicit_labels() {
		let labels = vec![String::from("red"), String::from("green"), String::from("blue")];
		assert_eq!(total_label_len(&labels), 12);
	}

	#[test]
	fn accepts_array_slice_without_allocating_vec() {
		let labels = [String::from("red"), String::from("green"), String::from("blue")];
		assert_eq!(total_label_len(&labels), 12);
	}

	#[test]
	fn totals_default_labels() {
		assert_eq!(default_total_label_len(), 12);
	}
}
